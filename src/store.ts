import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { key, type WorldStore } from './storage';

export { key };
export type { WorldStore };

export class Store implements WorldStore {
  private db: Database;
  private select;
  private insert;
  private counts;

  constructor(path: string, readonly namespace: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new Database(path, { create: true, strict: true });
    this.db.run('PRAGMA journal_mode=WAL');
    this.db.run('PRAGMA busy_timeout=5000');
    this.db.run(`CREATE TABLE IF NOT EXISTS records (
      namespace TEXT NOT NULL, kind TEXT NOT NULL, key TEXT NOT NULL,
      data TEXT NOT NULL, created_at INTEGER NOT NULL,
      PRIMARY KEY(namespace,kind,key)
    )`);
    this.select = this.db.query('SELECT data FROM records WHERE namespace=? AND kind=? AND key=?');
    this.insert = this.db.query('INSERT OR IGNORE INTO records VALUES (?,?,?,?,?) RETURNING data');
    this.counts = this.db.query('SELECT kind, COUNT(*) AS n FROM records WHERE namespace=? GROUP BY kind');
  }

  get<T>(kind: string, key: string): T | undefined {
    const row = this.select.get(this.namespace, kind, key) as { data: string } | null;
    return row ? JSON.parse(row.data) as T : undefined;
  }

  put<T>(kind: string, key: string, data: T): T {
    // INSERT OR IGNORE + RETURNING: one round trip on the common miss path;
    // on conflict SQLite returns no row and we read the original value back.
    const row = this.insert.get(this.namespace, kind, key, JSON.stringify(data), Date.now()) as { data: string } | null;
    return row ? JSON.parse(row.data) as T : this.get<T>(kind, key)!;
  }

  stats(): Record<string, number> {
    const rows = this.counts.all(this.namespace) as { kind: string; n: number }[];
    return Object.fromEntries(rows.map(r => [r.kind, Number(r.n)]));
  }

  close() { this.db.close(); }
}
