import type { WorldStore } from '../src/storage';

// Small injectable boundary: tests need no real browser or provider credentials.
export interface WorldLocks {
  request<T>(name: string, options: { mode: 'exclusive'; signal?: AbortSignal },
    callback: () => Promise<T>): Promise<T>;
}
function browserStorage(): Storage | undefined {
  try { return globalThis.localStorage; }
  catch { return undefined; }
}
function browserLocks(): WorldLocks | undefined {
  try { return globalThis.navigator?.locks; }
  catch { return undefined; }
}

/** Per-record persistence with session memory on failure.
 * Atomicity is provided by exclusive() around a World miss/recheck/generate/
 * commit, including the site's profile and composed artifact. put() itself is
 * synchronous and MUST NOT be used as a cross-tab compare-and-set operation.
 */
export class LocalStore implements WorldStore {
  private readonly prefix: string;
  private readonly memory = new Map<string, string>();
  private readonly storage: Storage | undefined;
  private readonly locks: WorldLocks | undefined;

  constructor(namespace: string, storage?: Storage | null, locks?: WorldLocks | null) {
    this.prefix = `agentworld.world.${namespace}.`;
    this.storage = storage === undefined ? browserStorage() : storage ?? undefined;
    this.locks = locks === undefined ? browserLocks() : locks ?? undefined;
  }
  private recordKey(kind: string, itemKey: string): string {
    return `${this.prefix}${kind}/${encodeURIComponent(itemKey)}`;
  }
  async exclusive<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    if (!this.storage) return work(); // no shared persistence to coordinate
    if (!this.locks) {
      throw new Error('瀏覽器持久模式需要 Web Locks 與安全來源；此環境未提供，已停止生成，未改用無鎖寫入。');
    }
    // Held by the flight's work, NOT by a caller's early-cancelled waiter.
    return this.locks.request(`${this.prefix}materialize`, { mode: 'exclusive', signal }, async () => {
      signal?.throwIfAborted();
      return work();
    });
  }
  get<T>(kind: string, itemKey: string): T | undefined {
    const k = this.recordKey(kind, itemKey);
    try {
      const raw = this.storage?.getItem(k);
      if (raw != null) {
        const parsed = JSON.parse(raw) as T;
        this.memory.set(k, raw);
        return parsed;
      }
    } catch { /* denied access or corrupt persisted record: consult session */ }
    const raw = this.memory.get(k);
    return raw === undefined ? undefined : JSON.parse(raw) as T;
  }
  put<T>(kind: string, itemKey: string, data: T): T {
    const existing = this.get<T>(kind, itemKey);
    if (existing !== undefined) return existing;
    const k = this.recordKey(kind, itemKey);
    const raw = JSON.stringify(data);
    if (raw === undefined) throw new Error('World records must be JSON serializable');
    // Serialization errors are not swallowed as if they were storage errors.
    this.memory.set(k, raw);
    try { this.storage?.setItem(k, raw); }
    catch { /* session copy above survives denied/quota-exhausted storage */ }
    return JSON.parse(raw) as T;
  }
  stats(): Record<string, number> {
    const keys = new Set(this.memory.keys());
    try {
      if (this.storage) for (let i = 0; i < this.storage.length; i++) {
        const k = this.storage.key(i);
        if (k?.startsWith(this.prefix)) keys.add(k);
      }
    } catch { /* includes a throwing length accessor */ }
    const counts = new Map<string, number>();
    for (const k of keys) {
      const rest = k.slice(this.prefix.length);
      const slash = rest.indexOf('/');
      if (slash < 1) continue;
      const kind = rest.slice(0, slash);
      counts.set(kind, (counts.get(kind) ?? 0) + 1);
    }
    return Object.fromEntries(counts);
  }
  close(): void { /* records persist on successful writes */ }
}
