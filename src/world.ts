import type { Spec } from '@json-render/core';
import { SharedFlights } from './shared-flight';
import { canonicalUrl, normalizePage, normalizeSearch, type CompositionInfo, type Context, type Page, type Search, type Result, type Policy, type Site } from './domain';
import { composePage, composeSearch } from './composer';
import { Providers } from './providers';
import { key, type WorldStore } from './storage';
export type SearchDocument = Search & { query: string; policy: { intent: string; confidence: number; source: 'jev' | 'mock' } };
interface PageArtifact { document: Page; spec: Spec; composition: CompositionInfo }
interface SearchArtifact { document: SearchDocument; spec: Spec; composition: CompositionInfo }
interface CachedResult<T> { data: T; cached: boolean; mode: 'live' | 'mock'; generation: 'openai' | 'mock'; elapsedMs: number }

export class World {
  private flights = new SharedFlights();
  private siteTails = new Map<string, Promise<unknown>>();
  constructor(readonly store: WorldStore, readonly providers: Providers) {}
  private async materialize<T>(kind: string, identity: string, generate: (signal?: AbortSignal) => Promise<T>, signal?: AbortSignal): Promise<CachedResult<T>> {
    signal?.throwIfAborted();
    const started = Date.now(); const k = key(identity); const id = `${kind}:${k}`;
    let data = this.store.get<T>(kind, k); let cached = data !== undefined;
    if (data === undefined) {
      if (this.flights.has(id)) cached = true;
      data = await this.flights.run<T>(id, async taskSignal => {
        const work = async () => {
          taskSignal.throwIfAborted();
          // Another tab may have committed while this flight waited for its lock.
          const stored = this.store.get<T>(kind, k);
          if (stored !== undefined) { cached = true; return stored; }
          const generated = await generate(taskSignal);
          taskSignal.throwIfAborted();
          return this.store.put(kind, k, generated);
        };
        return this.store.exclusive ? this.store.exclusive(work, taskSignal) : work();
      }, signal);
    }
    signal?.throwIfAborted();
    return { data, cached, mode: this.providers.config.mode,
      generation: this.providers.config.mode === 'mock' ? 'mock' : 'openai', elapsedMs: Date.now() - started };
  }
  async page(urlInput: string, fromInput = '', ctx = '', signal?: AbortSignal): Promise<Result<Page>> {
    const url = canonicalUrl(urlInput); const from = fromInput ? canonicalUrl(fromInput) : undefined;
    const result = await this.materialize<PageArtifact>('page', url, async (taskSignal) => {
      const host = new URL(url).hostname;
      const previousTail = this.siteTails.get(host) ?? Promise.resolve();
      const task = previousTail.catch(() => {}).then(async () => {
        taskSignal?.throwIfAborted();
        const site = this.store.get<Site>('site', host);
        const previous = from ? this.store.get<PageArtifact>('page', key(from))?.document.summary : undefined;
        const context: Context = { url, from, ctx: ctx.slice(0, 200), previous, site };
        const mock = this.providers.config.mode === 'mock';
        const policy: Policy = await this.providers.pagePolicy(context, taskSignal);
        taskSignal?.throwIfAborted();
        const draft = mock ? {
          title: ctx || decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).pop() || host),
          siteName: host, summary: `A fictional observation at ${url}.`, imageAlt: 'Simulated scene — no external image loaded',
          sections: [
            { heading: 'Overview', kind: 'text' as const, body: `This is a deterministic MOCK fixture for ${url}. No external model has been called.` },
            { heading: 'Explore this world', kind: 'text' as const, body: previous || 'Every link stays inside the simulator and materializes another fictional page.' },
          ],
          links: [1, 2, 3, 4].map(i => ({ label: `Explore topic ${i}`, url: `${url.replace(/\?.*$/, '').replace(/\/$/, '')}/topic-${i}` })),
        } : await this.providers.page(context, policy, taskSignal);
        taskSignal?.throwIfAborted();
        const normalized = normalizePage(draft, url, policy, site);
        const proposedSite: Site = site ?? { name: normalized.siteName, palette: normalized.policy.palette };
        const page = { ...normalized, siteName: proposedSite.name, policy: { ...normalized.policy, palette: proposedSite.palette } };
        const composed = await composePage(page, this.providers.compositionEvaluator(), this.providers.config, taskSignal);
        taskSignal?.throwIfAborted();
        const savedSite = this.store.put<Site>('site', host, proposedSite);
        return { document: { ...page, siteName: savedSite.name, policy: { ...page.policy, palette: savedSite.palette } }, ...composed };
      });
      this.siteTails.set(host, task);
      try { return await task; }
      finally { if (this.siteTails.get(host) === task) this.siteTails.delete(host); }
    }, signal);
    return { ...result, data: result.data.document, spec: result.data.spec, composition: result.data.composition };
  }
  async search(input: string, signal?: AbortSignal): Promise<Result<SearchDocument>> {
    const query = input.trim().replace(/\s+/g, ' ');
    if (!query || query.length > 500) throw new Error('Search must contain 1–500 characters');
    const result = await this.materialize<SearchArtifact>('search', query, async (taskSignal) => {
      const mock = this.providers.config.mode === 'mock';
      const policy = await this.providers.searchPolicy(query, taskSignal);
      taskSignal?.throwIfAborted();
      const draft = mock ? {
        results: ['atlas', 'journal', 'forum', 'archive', 'guide', 'lab'].map((host, i) => ({
          title: `${query} — ${host}`, url: `https://${host}.simulated.test/topics/${encodeURIComponent(query)}-${i}`,
          snippet: `MOCK result ${i + 1}: a fictional entry about ${query}.`,
        })), related: [`${query} history`, `${query} examples`],
      } : await this.providers.search(query, policy.intent, taskSignal);
      taskSignal?.throwIfAborted();
      const document: SearchDocument = { ...normalizeSearch(draft), query, policy };
      const composed = await composeSearch(query, document, this.providers.compositionEvaluator(), this.providers.config, taskSignal);
      return { document, ...composed };
    }, signal);
    return { ...result, data: result.data.document, spec: result.data.spec, composition: result.data.composition };
  }
}
