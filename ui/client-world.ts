import type { Config } from '../src/config';
import { namespace } from '../src/config';
import { World } from '../src/world';
import { Providers } from '../src/providers';
import { type WorldStore } from '../src/storage';
import {
  OPENROUTER_BASE, OPENROUTER_DECISIONS_BASE,
  type BrowserSettings,
} from './settings';

/**
 * localStorage-backed WorldStore used when the static build runs without the
 * Bun server (GitHub Pages). Mirrors the SQLite store's semantics: writes are
 * insert-or-ignore, records are namespaced by world namespace.
 */
export class LocalStore implements WorldStore {
  private cache = new Map<string, Map<string, unknown>>();
  private readonly prefix: string;

  constructor(namespace: string, private readonly storage: Storage = localStorage) {
    this.prefix = `agentworld.world.${namespace}.`;
  }

  private blobKey(kind: string): string {
    return this.prefix + kind;
  }

  private load(kind: string): Map<string, unknown> {
    let bucket = this.cache.get(kind);
    if (!bucket) {
      bucket = new Map();
      try {
        const raw = this.storage.getItem(this.blobKey(kind));
        if (raw) {
          const object = JSON.parse(raw) as Record<string, unknown>;
          for (const [k, v] of Object.entries(object)) bucket.set(k, v);
        }
      } catch { /* corrupted blob → start this kind fresh */ }
      this.cache.set(kind, bucket);
    }
    return bucket;
  }

  get<T>(kind: string, itemKey: string): T | undefined {
    return this.load(kind).get(itemKey) as T | undefined;
  }

  put<T>(kind: string, itemKey: string, data: T): T {
    const bucket = this.load(kind);
    if (bucket.has(itemKey)) return bucket.get(itemKey) as T;
    bucket.set(itemKey, data);
    try {
      this.storage.setItem(this.blobKey(kind), JSON.stringify(Object.fromEntries(bucket)));
    } catch { /* quota exceeded → keep the in-memory copy for this session */ }
    return data;
  }

  stats(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const kind of this.cache.keys()) out[kind] = this.load(kind).size;
    for (let i = 0; i < this.storage.length; i++) {
      const stored = this.storage.key(i);
      if (!stored || !stored.startsWith(this.prefix)) continue;
      const kind = stored.slice(this.prefix.length);
      if (kind in out) continue;
      try {
        out[kind] = Object.keys(JSON.parse(this.storage.getItem(stored) ?? '{}')).length;
      } catch { out[kind] = 0; }
    }
    return out;
  }

  close(): void { /* localStorage persists on write */ }
}

/** Browser-mode world: same pipeline as the server, providers called directly. */
export function createBrowserWorld(settings: BrowserSettings): World {
  const config: Config = {
    mode: 'live',
    host: '127.0.0.1', port: 0, db: '',
    epoch: 'browser-openrouter-1',
    jevBase: OPENROUTER_DECISIONS_BASE,
    jevPath: '/decisions',
    jevKey: settings.apiKey,
    jevModel: settings.decisionsModel,
    jevEvalTimeout: 30000,
    composeTimeout: 90000,
    composeMaxSteps: 4,
    composeMaxElements: 32,
    composeMaxDepth: 4,
    base: OPENROUTER_BASE,
    model: settings.generatorModel,
    key: settings.apiKey,
    jsonMode: 'json_object',
    thinking: 'omit',
    maxTokens: 4096,
    timeout: 120000,
  };
  // namespace() excludes credentials by design (same rule as server mode).
  return new World(new LocalStore(namespace(config)), new Providers(config));
}
