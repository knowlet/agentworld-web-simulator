import { sha256Hex } from './hash';

/**
 * Storage contract shared by the Bun SQLite store (server mode) and the
 * localStorage-backed store (browser mode on a static host). Keeping this in a
 * separate module lets `src/world.ts` stay runtime-agnostic.
 */
export interface WorldStore {
  get<T>(kind: string, key: string): T | undefined;
  put<T>(kind: string, key: string, data: T): T;
  stats(): Record<string, number>;
  close(): void;
}

/** Stable content key for a world observation (sha256 hex, as before). */
export function key(s: string) {
  return sha256Hex(s);
}
