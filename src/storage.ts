import { sha256Hex } from './hash';

/**
 * Storage contract shared by the Bun SQLite store (server mode) and the
 * localStorage-backed store (browser mode on a static host). Keeping this in a
 * separate module lets `src/world.ts` stay runtime-agnostic.
 */
export interface WorldStore {
  /** Optional serialization of a complete miss/recheck/generate/commit.
   * Browser LocalStore uses one namespace-wide Web Lock, including site writes.
   * The flight owns this promise; cancelling one waiter must not release it.
   */
  exclusive?<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T>;
  get<T>(kind: string, key: string): T | undefined;
  put<T>(kind: string, key: string, data: T): T;
  stats(): Record<string, number>;
  close(): void;
}

/** Stable content key for a world observation (sha256 hex, as before). */
export function key(s: string) {
  return sha256Hex(s);
}
