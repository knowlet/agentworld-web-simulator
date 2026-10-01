import {
  experimental_composeSpec,
  type Experimental_CompositionCandidate,
  type Experimental_CompositionEvaluator,
  type Spec,
} from '@json-render/core';
import type { Config } from './config';
import { catalog } from './catalog';
import { layouts, viewHref, type CompositionInfo, type Page, type Search } from './domain';

export const JSON_RENDER_UPSTREAM = '3ad381881194e7011ad3ccd6d668033495a06c29';

function short(value: string, max = 160): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, max);
}
function host(value: string): string {
  try { return new URL(value).hostname; } catch { return 'simulated destination'; }
}

export function pageCandidates(page: Page): Experimental_CompositionCandidate[] {
  const rootLayouts = [page.policy.layout, ...layouts.filter(x => x !== page.policy.layout)];
  const candidates: Experimental_CompositionCandidate[] = rootLayouts.map(layout => ({
    id: `surface-${layout}`,
    description: `${layout} page surface${layout === page.policy.layout ? '; preferred by the world-policy classification' : ''}`,
    resource: 'page-surface',
    element: { type: 'Surface', props: { layout, palette: page.policy.palette } },
  }));
  candidates.push({
    id: 'header', root: false,
    description: `Required site header for ${short(page.siteName, 80)} titled ${short(page.title, 100)}`,
    element: { type: 'Header', props: { title: page.title, subtitle: page.summary, brand: page.siteName } },
  });
  if (page.imageAlt) candidates.push({
    id: 'image', root: false,
    description: `Optional simulated image placeholder: ${short(page.imageAlt, 100)}`,
    element: { type: 'Placeholder', props: { alt: page.imageAlt } },
  });
  page.sections.forEach((section, i) => candidates.push({
    id: `section-${i}`, root: false,
    description: `Required content section ${i + 1}/${page.sections.length}: ${short(section.heading, 100)} (${section.kind})`,
    element: { type: 'Section', props: section },
  }));
  candidates.push({
    id: 'outgoing-links', root: false,
    description: 'Navigation container for the required outgoing links to other simulated pages',
    element: { type: 'Links', props: { title: 'Explore this world' } },
  });
  page.links.forEach((link, i) => candidates.push({
    id: `link-${i}`, root: false,
    description: `Required outgoing navigation link ${i + 1}/${page.links.length}: ${short(link.label, 100)} on ${host(link.url)}`,
    element: { type: 'Link', props: {
      label: link.label,
      href: viewHref(link.url, page.url, link.label),
      detail: host(link.url),
    } },
  }));
  return candidates;
}

export function searchCandidates(query: string, data: Search): Experimental_CompositionCandidate[] {
  const candidates: Experimental_CompositionCandidate[] = [{
    id: 'search-surface', description: 'Search-results page surface', resource: 'page-surface',
    element: { type: 'Surface', props: { layout: 'article', palette: 'neutral' } },
  }, {
    id: 'header', root: false,
    description: `Required search heading for query ${short(query, 120)}`,
    element: { type: 'Header', props: {
      title: query,
      subtitle: `${data.results.length} simulated results. These are fictional, not live search results.`,
      brand: 'AgentWorld Search',
    } },
  }, {
    id: 'results', root: false,
    description: 'Container for required simulated search results',
    element: { type: 'Links', props: { title: 'Search results' } },
  }];
  data.results.forEach((r, i) => candidates.push({
    id: `result-${i}`, root: false,
    description: `Required search result ${i + 1}/${data.results.length}: ${short(r.title, 100)} on ${host(r.url)}`,
    element: { type: 'Link', props: { label: r.title, href: viewHref(r.url, '', r.title), detail: r.snippet } },
  }));
  candidates.push({
    id: 'related', root: false,
    description: 'Container for optional related simulated searches',
    element: { type: 'Links', props: { title: 'Related searches' } },
  });
  data.related.forEach((q, i) => candidates.push({
    id: `related-${i}`, root: false,
    description: `Related search suggestion: ${short(q, 120)}`,
    element: { type: 'Link', props: { label: q, href: '/search?' + new URLSearchParams({ q }), detail: 'Search this simulated world' } },
  }));
  return candidates;
}

function requireTypes(spec: Spec, required: string[]) {
  const types = new Set(Object.values(spec.elements).map(element => element.type));
  for (const type of required) if (!types.has(type)) throw new Error(`Composed spec omitted required ${type} content.`);
}

function requireLinksGrouped(spec: Spec) {
  const grouped = new Set<string>();
  for (const element of Object.values(spec.elements)) {
    if (element.type !== 'Links') continue;
    for (const id of element.children ?? []) grouped.add(id);
    for (const value of Object.values(element.slots ?? {})) {
      if (Array.isArray(value)) for (const id of value) if (typeof id === 'string') grouped.add(id);
    }
  }
  for (const [id, element] of Object.entries(spec.elements)) {
    if (element.type === 'Link' && !grouped.has(id)) throw new Error('Composed spec placed a navigation Link outside a Links container.');
  }
}

async function compose(
  candidates: readonly Experimental_CompositionCandidate[],
  prompt: string,
  context: Record<string, unknown>,
  evaluate: Experimental_CompositionEvaluator,
  config: Config,
  source: CompositionInfo['source'],
  requiredTypes: string[],
  externalSignal?: AbortSignal,
): Promise<{ spec: Spec; composition: CompositionInfo }> {
  let finalSpec: Spec | null = null;
  let complete: { stopReason: 'finish' | 'limit' | 'unavailable'; evaluations: number; inputTokens: number | null } | null = null;
  const timeout = AbortSignal.timeout(config.composeTimeout);
  const signal = externalSignal ? AbortSignal.any([timeout, externalSignal]) : timeout;
  for await (const event of experimental_composeSpec({
    catalog,
    candidates,
    prompt,
    context,
    evaluate,
    strategy: 'batch',
    maxSteps: config.composeMaxSteps,
    maxElements: config.composeMaxElements,
    maxDepth: config.composeMaxDepth,
    signal,
    instructions: {
      root: 'Choose exactly one Surface root. Prefer the surface matching the world-policy hint when appropriate.',
      next: 'Candidates described as Required are essential to this observation. Keep all required semantic content and links; decide composition, grouping, and reading order rather than rewriting data.',
      parent: 'Place navigation Link elements inside a suitable Links container when possible; place primary content under the page Surface in conventional reading order.',
    },
  })) {
    if (event.spec) finalSpec = event.spec;
    if (event.type === 'complete') complete = {
      stopReason: event.stopReason,
      evaluations: event.steps.length,
      inputTokens: event.inputTokens,
    };
  }
  if (!complete || complete.stopReason !== 'finish' || !finalSpec) {
    throw new Error(`json-render Jev composition did not finish (${complete?.stopReason || 'no result'}).`);
  }
  if (!catalog.validate(finalSpec).success) throw new Error('json-render Jev composition returned a spec outside the catalog.');
  requireTypes(finalSpec, requiredTypes);
  requireLinksGrouped(finalSpec);
  return { spec: finalSpec, composition: {
    source, stopReason: 'finish', evaluations: complete.evaluations, inputTokens: complete.inputTokens,
  } };
}

export function composePage(page: Page, evaluate: Experimental_CompositionEvaluator, config: Config, signal?: AbortSignal) {
  return compose(pageCandidates(page),
    `Compose a complete simulated web page for ${page.url}. Preserve every required generated section and outgoing link. The world-policy page type is ${page.policy.layout}; Jev should choose the final component tree, grouping, and order.`,
    { kind: 'page', url: page.url, site: page.siteName, title: page.title, worldPolicy: page.policy.layout },
    evaluate, config, config.mode === 'mock' ? 'mock' : 'json-render-jev', ['Surface', 'Header', 'Section', 'Links', 'Link'], signal);
}

export function composeSearch(query: string, data: Search, evaluate: Experimental_CompositionEvaluator, config: Config, signal?: AbortSignal) {
  return compose(searchCandidates(query, data),
    `Compose a simulated search-results page for the query ${JSON.stringify(short(query, 200))}. Include the heading and all required search-result links; related searches are optional.`,
    { kind: 'search', query: short(query, 200), resultCount: data.results.length },
    evaluate, config, config.mode === 'mock' ? 'mock' : 'json-render-jev', ['Surface', 'Header', 'Links', 'Link'], signal);
}
