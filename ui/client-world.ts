import type { Config } from '../src/config';
import { namespace } from '../src/config';
import { World } from '../src/world';
import { Providers } from '../src/providers';
import type { WorldStore } from '../src/storage';
import {
  OPENROUTER_BASE,
  type BrowserSettings,
} from './settings';

/**
 * localStorage-backed WorldStore used when the static build runs without the
 * Bun server (GitHub Pages). Records live under separate keys
 * (`<prefix><kind>/<item>`) so concurrent tabs never clobber each other with a
 * stale whole-blob write. Mirrors the SQLite store's insert-or-ignore rule.
 */
export class LocalStore implements WorldStore {
  private readonly prefix: string;

  constructor(namespace: string, private readonly storage: Storage = localStorage) {
    this.prefix = `agentworld.world.${namespace}.`;
  }

  private recordKey(kind: string, itemKey: string): string {
    return `${this.prefix}${kind}/${encodeURIComponent(itemKey)}`;
  }

  get<T>(kind: string, itemKey: string): T | undefined {
    let raw: string | null;
    try {
      raw = this.storage.getItem(this.recordKey(kind, itemKey));
    } catch {
      return undefined;
    }
    if (raw == null) return undefined;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return undefined;
    }
  }

  put<T>(kind: string, itemKey: string, data: T): T {
    const existing = this.get<T>(kind, itemKey);
    if (existing !== undefined) return existing;
    try {
      this.storage.setItem(this.recordKey(kind, itemKey), JSON.stringify(data));
    } catch { /* quota exceeded → keep the in-memory result for this session */ }
    return data;
  }

  stats(): Record<string, number> {
    const out: Record<string, number> = {};
    const base = this.prefix.length;
    for (let i = 0; i < this.storage.length; i++) {
      let stored: string | null;
      try {
        stored = this.storage.key(i);
      } catch {
        continue;
      }
      if (!stored || !stored.startsWith(this.prefix)) continue;
      const rest = stored.slice(base);
      const slash = rest.indexOf('/');
      if (slash < 0) continue;
      const kind = rest.slice(0, slash);
      out[kind] = (out[kind] ?? 0) + 1;
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
    jevBase: OPENROUTER_BASE,
    jevPath: '/chat/completions',
    // Browser mode has no server-side adapter: any OpenAI-compatible chat
    // model answers the Choice questions directly (strict in-catalog).
    // Native decisions models belong to server mode (JEV_PROTOCOL=systemone).
    jevProtocol: 'choice-chat',
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
