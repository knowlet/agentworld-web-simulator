import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { SharedFlights } from '../src/shared-flight';
import { LocalStore, type WorldLocks } from '../ui/local-store';
import { NATIVE_DECISIONS, assertNativeDecisionModel, isNativeDecisionModel } from '../ui/decision-models';
import { absoluteFor } from '../ui/base-path';
import { isEmbedded } from '../ui/frame-guard';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}
class MemoryStorage implements Storage {
  protected data = new Map<string, string>();
  get length() { return this.data.size; }
  key(index: number) { return [...this.data.keys()][index] ?? null; }
  getItem(key: string) { return this.data.get(key) ?? null; }
  setItem(key: string, value: string) { this.data.set(key, value); }
  removeItem(key: string) { this.data.delete(key); }
  clear() { this.data.clear(); }
}
/** Test double only. Browser-engine Web Locks tests remain a separate gate. */
class QueuedLocks implements WorldLocks {
  private tails = new Map<string, Promise<unknown>>();
  request<T>(name: string, options: { mode: 'exclusive'; signal?: AbortSignal }, callback: () => Promise<T>): Promise<T> {
    options.signal?.throwIfAborted();
    const previous = this.tails.get(name) ?? Promise.resolve();
    let granted = false;
    const job = previous.catch(() => {}).then(() => {
      options.signal?.throwIfAborted();
      granted = true;
      return callback();
    });
    this.tails.set(name, job);
    return new Promise<T>((resolve, reject) => {
      const abort = () => { if (!granted) reject(options.signal?.reason); };
      options.signal?.addEventListener('abort', abort, { once: true });
      void job.then(resolve, reject).finally(() => {
        options.signal?.removeEventListener('abort', abort);
        if (this.tails.get(name) === job) this.tails.delete(name);
      });
    });
  }
}

test('PR1: pre-aborted waiter starts zero work', async () => {
  const flights = new SharedFlights(); const ac = new AbortController(); ac.abort();
  let calls = 0;
  await assert.rejects(flights.run('a', async () => ++calls, ac.signal), { name: 'AbortError' });
  assert.equal(calls, 0); assert.equal(flights.has('a'), false);
});
test('PR1: creator abort does not abort a surviving follower', async () => {
  const f = new SharedFlights(); const started = deferred<AbortSignal>(); const done = deferred<string>();
  const ac = new AbortController(); let calls = 0;
  const generate = async (signal: AbortSignal) => { calls++; started.resolve(signal); return done.promise; };
  const a = f.run('a', generate, ac.signal);
  const rejected = assert.rejects(a, { name: 'AbortError' });
  const b = f.run('a', generate);
  const workSignal = await started.promise;
  ac.abort(); await rejected;
  assert.equal(workSignal.aborted, false);
  done.resolve('ok'); assert.equal(await b, 'ok'); assert.equal(calls, 1);
});
test('PR1: follower abort settles without waiting for creator work', async () => {
  const f = new SharedFlights(); const started = deferred<AbortSignal>(); const done = deferred<number>();
  const a = f.run('a', async signal => { started.resolve(signal); return done.promise; });
  const ac = new AbortController(); const b = f.run('a', async () => 99, ac.signal);
  const rejection = assert.rejects(b, { name: 'AbortError' });
  const workSignal = await started.promise; ac.abort(); await rejection;
  assert.equal(workSignal.aborted, false); done.resolve(1); assert.equal(await a, 1);
});
test('PR1: last waiter abort cancels work and permits an immediate replacement', async () => {
  const f = new SharedFlights(); const started = deferred<AbortSignal>(); const oldDone = deferred<number>();
  const ac = new AbortController();
  const a = f.run('x', async signal => { started.resolve(signal); return oldDone.promise; }, ac.signal);
  const rejection = assert.rejects(a, { name: 'AbortError' });
  const signal = await started.promise; ac.abort(); await rejection;
  assert.equal(signal.aborted, true); assert.equal(f.has('x'), false);
  assert.equal(await f.run('x', async () => 2), 2);
  oldDone.resolve(1); // ignored old completion, not an unhandled rejection
});
test('PR1: old cleanup cannot remove a newer flight at the same key', async () => {
  const f = new SharedFlights(); const entered = deferred<void>(); const oldDone = deferred<number>();
  const freshDone = deferred<number>(); const ac = new AbortController(); let newCalls = 0;
  const old = f.run('x', async () => { entered.resolve(); return oldDone.promise; }, ac.signal);
  const rejection = assert.rejects(old, { name: 'AbortError' }); await entered.promise;
  ac.abort(); await rejection;
  const fresh = f.run('x', async () => { newCalls++; return freshDone.promise; });
  oldDone.resolve(0); await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
  assert.equal(f.has('x'), true);
  const follower = f.run('x', async () => { newCalls++; return 9; });
  freshDone.resolve(7); assert.deepEqual(await Promise.all([fresh, follower]), [7, 7]);
  assert.equal(newCalls, 1);
});
test('PR1: failed shared work rejects every waiter and remains retryable', async () => {
  const f = new SharedFlights(); const fail = deferred<number>(); let n = 0;
  const generate = async () => { n++; return fail.promise; };
  const a = f.run('x', generate); const b = f.run('x', generate);
  const outcomes = Promise.allSettled([a, b]); fail.reject(new Error('fixture failure'));
  assert.ok((await outcomes).every(r => r.status === 'rejected')); assert.equal(n, 1);
  assert.equal(await f.run('x', async () => 3), 3);
});
test('PR1: separate flight identities remain independent', async () => {
  const f = new SharedFlights(); const blocked = deferred<number>();
  const a = f.run('a', async () => blocked.promise);
  assert.equal(await f.run('b', async () => 2), 2); blocked.resolve(1); assert.equal(await a, 1);
});
test('PR1: settled work removes flight bookkeeping', async () => {
  const f = new SharedFlights(); assert.equal(await f.run('x', async () => 5), 5);
  assert.equal(f.has('x'), false);
});
test('PR1: cancelling two waiters cancels upstream only after the last leaves', async () => {
  const f = new SharedFlights(); const begun = deferred<AbortSignal>(); const done = deferred<number>();
  const aa = new AbortController(); const bb = new AbortController();
  const a = f.run('x', async signal => { begun.resolve(signal); return done.promise; }, aa.signal);
  const b = f.run('x', async () => 2, bb.signal);
  const ar = assert.rejects(a); const br = assert.rejects(b); const upstream = await begun.promise;
  aa.abort(); await ar; assert.equal(upstream.aborted, false);
  bb.abort(); await br; assert.equal(upstream.aborted, true); done.resolve(1);
});

test('PR1: denied writes retain the first session value and stats', () => {
  const storage = new MemoryStorage(); storage.setItem = () => { throw new Error('quota'); };
  const store = new LocalStore('one', storage, null);
  assert.deepEqual(store.put('page', 'x', { n: 1 }), { n: 1 });
  assert.deepEqual(store.put('page', 'x', { n: 2 }), { n: 1 });
  assert.deepEqual(store.get('page', 'x'), { n: 1 }); assert.deepEqual(store.stats(), { page: 1 });
});
test('PR1: denied reads retain generated memory data', () => {
  const storage = new MemoryStorage(); storage.getItem = () => { throw new Error('denied'); };
  storage.setItem = () => { throw new Error('denied'); };
  const store = new LocalStore('one', storage, null);
  store.put('search', 'x', { title: 'remember' }); assert.deepEqual(store.get('search', 'x'), { title: 'remember' });
});
test('PR1: unavailable storage is an explicit per-instance memory session', async () => {
  const a = new LocalStore('one', null, null); const b = new LocalStore('one', null, null);
  await a.exclusive(async () => a.put('page', 'x', 1));
  assert.equal(a.get('page', 'x'), 1); assert.equal(b.get('page', 'x'), undefined);
});
test('PR1: length accessor failure cannot crash stats', () => {
  const storage = new MemoryStorage(); const store = new LocalStore('one', storage, null);
  store.put('page', 'x', 1);
  Object.defineProperty(storage, 'length', { get() { throw new Error('denied'); } });
  assert.deepEqual(store.stats(), { page: 1 });
});
test('PR1: separate records and namespaces remain isolated', () => {
  const storage = new MemoryStorage(); const a = new LocalStore('one', storage, null);
  const b = new LocalStore('one', storage, null); const c = new LocalStore('two', storage, null);
  a.put('page', 'a', 1); b.put('page', 'b', 2);
  assert.equal(a.get('page', 'b'), 2); assert.equal(b.get('page', 'a'), 1);
  assert.equal(c.get('page', 'a'), undefined); assert.deepEqual(a.stats(), { page: 2 });
});
test('PR1: missing locks cannot silently run persistent generation unlocked', async () => {
  const store = new LocalStore('one', new MemoryStorage(), null); let started = 0;
  await assert.rejects(store.exclusive(async () => ++started), /Web Locks/); assert.equal(started, 0);
});
test('PR1: same-key recheck under a shared namespace lock avoids double materialization', async () => {
  const storage = new MemoryStorage(); const locks = new QueuedLocks();
  const a = new LocalStore('one', storage, locks); const b = new LocalStore('one', storage, locks);
  const entered = deferred<void>(); const done = deferred<void>(); let calls = 0;
  const observe = (store: LocalStore, value: number) => store.exclusive(async () => {
    const cached = store.get<number>('page', 'x'); if (cached !== undefined) return cached;
    calls++; entered.resolve(); await done.promise; return store.put('page', 'x', value);
  });
  const first = observe(a, 1); await entered.promise; const second = observe(b, 2);
  done.resolve(); assert.deepEqual(await Promise.all([first, second]), [1, 1]); assert.equal(calls, 1);
});
test('PR1: an aborted lock waiter never starts generation', async () => {
  const locks = new QueuedLocks(); const storage = new MemoryStorage();
  const a = new LocalStore('one', storage, locks); const b = new LocalStore('one', storage, locks);
  const entered = deferred<void>(); const finish = deferred<void>(); const ac = new AbortController();
  const first = a.exclusive(async () => { entered.resolve(); await finish.promise; });
  await entered.promise; let calls = 0;
  const next = b.exclusive(async () => ++calls, ac.signal); const rejection = assert.rejects(next);
  ac.abort(); await rejection; assert.equal(calls, 0); finish.resolve(); await first;
});
test('PR1: caller cancellation does not release a lock before old work drains', async () => {
  const locks = new QueuedLocks(); const storage = new MemoryStorage();
  const store = new LocalStore('one', storage, locks); const f = new SharedFlights();
  const entered = deferred<void>(); const drain = deferred<void>(); const ac = new AbortController();
  const old = f.run('page:x', signal => store.exclusive(async () => {
    entered.resolve(); await drain.promise; signal.throwIfAborted(); return store.put('page', 'x', 1);
  }, signal), ac.signal);
  const rejection = assert.rejects(old); await entered.promise; ac.abort(); await rejection;
  let newStarted = false;
  const fresh = f.run('page:x', signal => store.exclusive(async () => {
    newStarted = true; return store.put('page', 'x', 2);
  }, signal));
  await Promise.resolve(); await Promise.resolve(); assert.equal(newStarted, false);
  drain.resolve(); assert.equal(await fresh, 2); assert.equal(store.get('page', 'x'), 2);
});
test('PR1: serialization bugs are not disguised as storage denial', () => {
  const store = new LocalStore('one', null, null);
  const cyclic: { self?: unknown } = {}; cyclic.self = cyclic;
  assert.throws(() => store.put('page', 'x', cyclic)); assert.equal(store.get('page', 'x'), undefined);
});
test('PR1: native allowlist accepts the supported decision ID, not related chat names', () => {
  assertNativeDecisionModel('inception/mercury-decide:free');
  assert.equal(isNativeDecisionModel('inception/mercury'), false);
  assert.throws(() => assertNativeDecisionModel('stealth/space-bunny-alpha'), /native Decisions/);
});
test('PR1: native model registry keeps endpoint and protocol together', () => {
  assert.deepEqual(NATIVE_DECISIONS, { base: 'https://openrouter.ai/api/alpha', path: '/decisions', protocol: 'systemone' });
});
test('PR1: whitespace normalization does not introduce fuzzy capability matching', () => {
  assertNativeDecisionModel(' inception/mercury-decide:free ');
  assert.throws(() => assertNativeDecisionModel('inception/mercury-decide:unknown'));
});
test('PR1: native anchor addresses include the deployment base exactly once', () => {
  assert.equal(absoluteFor('/view?url=x', '/agentworld-web-simulator/'), '/agentworld-web-simulator/view?url=x');
  assert.equal(absoluteFor('/search?q=a%20b', '/repo/'), '/repo/search?q=a%20b');
  assert.equal(absoluteFor('/', '/repo/'), '/repo/');
});
test('PR1: root deployment URLs remain unchanged', () => {
  assert.equal(absoluteFor('/search?q=x', '/'), '/search?q=x');
});
test('PR1: base helper cannot turn an unvalidated external URL into navigation', () => {
  assert.throws(() => absoluteFor('//other.test/'));
  assert.throws(() => absoluteFor('https://other.test/'));
  assert.throws(() => absoluteFor('/repo/view?url=x', '/repo/'));
});
test('PR1: frame guard allows only a verified top-level context', () => {
  const frame = {} as Window;
  assert.equal(isEmbedded({ self: frame, top: frame }), false);
  assert.equal(isEmbedded({ self: frame, top: {} as Window }), true);
});
test('PR1: frame guard denies access errors and a null top', () => {
  const frame = {} as Window;
  const blocked = { self: frame, get top(): Window { throw new Error('denied'); } };
  assert.equal(isEmbedded(blocked), true); assert.equal(isEmbedded({ self: frame, top: null }), true);
});

// The same transport and settings modules imported by the production UI.
import { createBrowserTransport } from '../ui/browser-transport';
import { defaultSettings, loadSettings, saveSettings } from '../ui/settings';

test('browser bridge forwards exact page/search signals and results', async () => {
  const ac = new AbortController(); const pageResult = { page: true }; const searchResult = { search: true };
  const transport = createBrowserTransport({
    page: async (url, from, ctx, signal) => {
      assert.equal(url, 'https://fixture.example/'); assert.equal(from, 'from'); assert.equal(ctx, 'ctx');
      assert.equal(signal, ac.signal); return pageResult;
    },
    search: async (query, signal) => { assert.equal(query, 'query'); assert.equal(signal, ac.signal); return searchResult; },
  });
  assert.equal(transport.kind, 'browser');
  assert.equal(await transport.page('https://fixture.example/', 'from', 'ctx', ac.signal), pageResult);
  assert.equal(await transport.search('query', ac.signal), searchResult);
});

test('browser bridge cancellation reaches a pending World call', async () => {
  const ac = new AbortController(); let aborted = false;
  const transport = createBrowserTransport({
    page: async () => undefined,
    search: (_q, signal) => new Promise<void>((_resolve, reject) => {
      assert.ok(signal);
      signal.addEventListener('abort', () => { aborted = true; reject(signal.reason); }, { once: true });
    }),
  });
  const result = transport.search('query', ac.signal);
  const rejected = assert.rejects(result, { name: 'AbortError' });
  ac.abort(); await rejected; assert.equal(aborted, true);
});

function withStorage(storage: Storage, work: () => void) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true });
  try { work(); }
  finally {
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }
}

test('settings clear failure reports non-persistence and never retains the active key', () => {
  const storage = new MemoryStorage();
  withStorage(storage, () => {
    saveSettings({ ...defaultSettings(), apiKey: 'fixture-only' });
    storage.setItem = () => { throw new Error('quota'); };
    const cleared = saveSettings({ ...defaultSettings(), apiKey: '' });
    assert.equal(cleared.settings.apiKey, '');
    assert.equal(cleared.persisted, false);
    assert.equal(loadSettings().apiKey, 'fixture-only', 'old persisted key remains, so success must not be claimed');
  });
});

test('stale persisted chat choice is kept visible for repair, never silently substituted', () => {
  const storage = new MemoryStorage();
  storage.setItem('agentworld.settings.v1', JSON.stringify({ ...defaultSettings(), apiKey: 'fixture-only', decisionsModel: 'ordinary/chat' }));
  withStorage(storage, () => {
    const loaded = loadSettings(); assert.equal(loaded.decisionsModel, 'ordinary/chat');
    assert.throws(() => saveSettings(loaded), /native Decisions/);
    const cleared = saveSettings({ ...loaded, apiKey: '' });
    assert.equal(cleared.settings.apiKey, ''); assert.equal(cleared.persisted, true);
  });
});

test('supported settings round-trip with normalized native model identity', () => {
  withStorage(new MemoryStorage(), () => {
    const defaults = defaultSettings();
    const saved = saveSettings({ ...defaults, apiKey: ' fixture-only ', decisionsModel: ` ${defaults.decisionsModel} ` });
    assert.equal(saved.persisted, true);
    assert.equal(loadSettings().decisionsModel, defaults.decisionsModel);
    assert.equal(loadSettings().apiKey, 'fixture-only');
  });
});
