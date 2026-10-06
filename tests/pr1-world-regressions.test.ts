// Repository integration regressions. Require Bun and the repository's pinned
// @json-render dependencies. NOT run by validation/run-isolated.cjs.
import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config';
import { Providers } from '../src/providers';
import { World } from '../src/world';
import { key } from '../src/storage';
import { LocalStore } from '../ui/local-store';
import { createBrowserWorld } from '../ui/client-world';
import { defaultSettings, saveSettings } from '../ui/settings';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(r => { resolve = r; });
  return { promise, resolve };
}
function interrupted<T>(signal: AbortSignal | undefined, entered: () => void): Promise<T> {
  assert.ok(signal, 'stage did not receive a signal');
  signal.throwIfAborted();
  return new Promise<T>((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    entered();
  });
}
async function bounded<T>(work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work, new Promise<T>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('regression: cancellation did not settle within 2 seconds')), 2000);
    })]);
  } finally { clearTimeout(timer); }
}
function fixtureProviders() {
  // Capture the real official composer's mock evaluator, then exercise the live
  // World branches using local content fixtures only. No network is permitted.
  const c = loadConfig({ APP_MODE: 'mock', WORLD_DB: ':memory:' });
  const p = new Providers(c, async () => { throw new Error('Network forbidden'); });
  p.config.mode = 'live';
  p.searchPolicy = async () => ({ intent: 'general' as const, confidence: 1, source: 'jev' as const });
  p.search = async () => ({
    results: [1, 2, 3, 4].map(i => ({ title: `Result ${i}`, url: `https://fixture.example/topic-${i}`, snippet: `Detail ${i}` })),
    related: ['related topic'],
  });
  return p;
}

for (const stage of ['policy', 'generation', 'composition'] as const) {
  test(`PR1 integration: abort DURING ${stage} stops subsequent stages and cache writes`, async () => {
    const p = fixtureProviders(); const store = new LocalStore(`cancel-${stage}`, null, null);
    const entered = deferred<void>(); const counts = { policy: 0, generation: 0, composition: 0 };
    const policy = p.searchPolicy.bind(p); const search = p.search.bind(p); const evaluate = p.compositionEvaluator();
    p.searchPolicy = async (q, signal) => {
      counts.policy++;
      if (stage === 'policy') return interrupted(signal, () => entered.resolve());
      return policy(q, signal);
    };
    p.search = async (q, intent, signal) => {
      counts.generation++;
      if (stage === 'generation') return interrupted(signal, () => entered.resolve());
      return search(q, intent, signal);
    };
    p.compositionEvaluator = () => async request => {
      counts.composition++;
      if (stage === 'composition') return interrupted(request.signal, () => entered.resolve());
      return evaluate(request);
    };
    const world = new World(store, p); const ac = new AbortController();
    const pending = world.search('cancel fixture', ac.signal);
    const rejected = assert.rejects(bounded(pending), { name: 'AbortError' });
    await bounded(entered.promise); ac.abort(); await rejected;
    assert.equal(store.get('search', key('cancel fixture')), undefined);
    if (stage === 'policy') assert.deepEqual(counts, { policy: 1, generation: 0, composition: 0 });
    if (stage === 'generation') assert.deepEqual(counts, { policy: 1, generation: 1, composition: 0 });
    if (stage === 'composition') assert.deepEqual(counts, { policy: 1, generation: 1, composition: 1 });
  });
}

test('PR1 integration: World creator abort does not fail a follower or duplicate generation', async () => {
  const p = fixtureProviders(); const gate = deferred<void>(); const entered = deferred<void>();
  const search = p.search.bind(p); let calls = 0;
  p.search = async (...args) => { calls++; entered.resolve(); await gate.promise; return search(...args); };
  const world = new World(new LocalStore('shared', null, null), p); const ac = new AbortController();
  const a = world.search('shared fixture', ac.signal); const ar = assert.rejects(bounded(a), { name: 'AbortError' });
  await bounded(entered.promise);
  const b = world.search('shared fixture'); ac.abort(); await ar; gate.resolve();
  assert.ok((await bounded(b)).spec.root); assert.equal(calls, 1);
  assert.equal((await world.search('shared fixture')).cached, true);
});

test('PR1 integration: late provider completion after last waiter abort cannot cache', async () => {
  const p = fixtureProviders(); const gate = deferred<void>(); const entered = deferred<void>();
  const search = p.search.bind(p); let compositions = 0;
  const evaluate = p.compositionEvaluator();
  p.compositionEvaluator = () => async request => { compositions++; return evaluate(request); };
  p.search = async (...args) => { entered.resolve(); await gate.promise; return search(...args); };
  const store = new LocalStore('late', null, null);
  // This boundary follows the actual work, not its early-cancelled waiter.
  const drained = deferred<void>();
  store.exclusive = async work => { try { return await work(); } finally { drained.resolve(); } };
  const world = new World(store, p); const ac = new AbortController();
  const pending = world.search('late fixture', ac.signal); const rejected = assert.rejects(bounded(pending));
  await bounded(entered.promise); ac.abort(); await rejected; gate.resolve();
  await bounded(drained.promise);
  assert.equal(store.get('search', key('late fixture')), undefined);
  assert.equal(compositions, 0);
});

test('PR1 integration: provider abort is event-driven mid-fetch, not its timeout', async () => {
  const entered = deferred<void>(); const ac = new AbortController(); let calls = 0;
  const p = new Providers(loadConfig({ APP_MODE: 'mock', REQUEST_TIMEOUT_MS: '120000' }), async (_url, init) => {
    calls++; return interrupted(init?.signal ?? undefined, () => entered.resolve());
  });
  const pending = p.post('openai', 'https://fixture.invalid/', 'fixture-only', {}, ac.signal);
  const rejected = assert.rejects(bounded(pending), /request cancelled/);
  await bounded(entered.promise); ac.abort(); await rejected; assert.equal(calls, 1);
});

test('PR1 integration: native factory rejects stale chat settings before any provider call', () => {
  assert.throws(() => createBrowserWorld({ ...defaultSettings(), apiKey: 'fixture-only', decisionsModel: 'ordinary/chat-model' }), /native Decisions/);
});
test('PR1 integration: native factory binds the supported model to the native tuple', () => {
  const world = createBrowserWorld({ ...defaultSettings(), apiKey: 'fixture-only' });
  assert.equal(world.providers.config.jevPath, '/decisions');
  assert.equal(world.providers.config.jevProtocol, 'systemone');
  assert.equal(world.providers.config.jevBase, 'https://openrouter.ai/api/alpha');
});
test('PR1 integration: save rejects invalid model settings but still permits clearing credentials', () => {
  const stale = { ...defaultSettings(), apiKey: 'fixture-only', decisionsModel: 'ordinary/chat-model' };
  assert.throws(() => saveSettings(stale), /native Decisions/);
  assert.equal(saveSettings({ ...stale, apiKey: '' }).settings.apiKey, '');
});
