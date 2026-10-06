import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderToStaticMarkup } from 'react-dom/server';
import { createElement } from 'react';
import { VERSION, canonicalUrl, normalizePage, pageDraftSchema, type PageDraft } from '../src/domain';
import { loadConfig, namespace } from '../src/config';
import { composePage } from '../src/composer';
import { Store, key } from '../src/store';
import { sha256Hex } from '../src/hash';
import { LocalStore } from '../ui/client-world';
import { defaultSettings, loadSettings, saveSettings } from '../ui/settings';
import { Providers } from '../src/providers';
import { World } from '../src/world';
import { createApp, listen } from '../src/server';
import { WorldView } from '../ui/registry';

const config = () => loadConfig({ APP_MODE: 'mock', WORLD_DB: ':memory:' });
const fixture: PageDraft = {
  title: 'Deep sea', siteName: 'Atlas', summary: 'A fictional ocean archive.', imageAlt: '',
  sections: [{ heading: 'Overview', kind: 'text', body: 'A specific overview.' }, { heading: 'Details', kind: 'code', body: 'const sea = true;' }],
  links: [1, 2, 3].map(i => ({ label: `Topic ${i}`, url: `/topic-${i}` })),
};
const policy = { layout: 'article', palette: 'blue', confidence: 0.9, source: 'jev' } as const;
function harness() {
  const c = config(); const store = new Store(':memory:', namespace(c));
  const providers = new Providers(c, async () => { throw new Error('Network forbidden in fixture mode'); });
  return { store, providers, world: new World(store, providers) };
}
function choose(questions: Record<string, { criteria: Record<string, unknown> }>, state: any = {}) {
  const selected = Array.isArray(state.selected_elements) ? state.selected_elements : [];
  const byId = new Map(selected.map((item: any) => [item.id, item]));
  return {
    answers: Object.fromEntries(Object.entries(questions).map(([name, q]) => {
      const keys = Object.keys(q.criteria); let choice = keys[0]!;
      if (name === 'root') choice = keys.find(k => k !== 'unavailable') ?? choice;
      else if (name.startsWith('select_')) choice = keys.find(k => k.startsWith('use:')) ?? (keys.includes('1') ? '1' : choice);
      else if (name.startsWith('parent_')) {
        const child: any = byId.get(name.slice('parent_'.length));
        const text = String(child?.content || '').toLowerCase();
        if (child?.type === 'Link') {
          const wanted = text.includes('related search') ? 'related'
            : text.includes('outgoing navigation') ? 'outgoing'
            : 'search result';
          choice = Object.entries(q.criteria).find(([key, description]) => {
            const parent: any = byId.get(key.split(':', 1)[0]);
            return parent?.type === 'Links' && String(description).toLowerCase().includes(wanted);
          })?.[0] ?? choice;
        } else {
          choice = keys.find(key => (byId.get(key.split(':', 1)[0]) as any)?.type === 'Surface') ?? choice;
        }
      } else if (name.startsWith('order_')) choice = keys.includes('1') ? '1' : choice;
      return [name, {
        type: 'choice' as const,
        choice,
        confidence: 1,
        probabilities: Object.fromEntries(keys.map(k => [k, k === choice ? 1 : 0])),
      }];
    })),
  };
}
function liveProvider(handler: (url: string, body: any, init: RequestInit) => Response | Promise<Response>) {
  const c = { ...config(), mode: 'live' as const, jevBase: 'https://api.typesafe.ai/v1', jevKey: 'private-jev-key', jevModel: 'jev-latest', key: 'private-openai-key' };
  return new Providers(c, async (url, init) => handler(String(url), JSON.parse(String(init?.body)), init!));
}

test('canonicalization retains query semantics and removes fragments', () => {
  assert.equal(canonicalUrl('https://EXAMPLE.org:443/a?q=1#section'), 'https://example.org/a?q=1');
  assert.equal(canonicalUrl('../next', 'https://example.org/docs/start'), 'https://example.org/next');
});
for (const url of ['javascript:alert(1)', 'data:text/html,abc', 'file:///etc/passwd', 'https://user:pass@example.org', 'https://a.org/\nadmin', 'https://a.org/with space', 'https://a.org/\\evil', 'http://localhost', '']) {
  test(`reject unsafe or invalid URL ${JSON.stringify(url)}`, () => assert.throws(() => canonicalUrl(url)));
}
test('page schema rejects executable extra fields and dead ends', () => {
  assert.equal(pageDraftSchema.safeParse({ ...fixture, script: 'alert(1)' }).success, false);
  assert.throws(() => normalizePage({ ...fixture, links: fixture.links.map(l => ({ ...l, url: '/same' })) }, 'https://a.org/same', policy));
});
test('official composer output renders model fields as escaped text, never markup', async () => {
  const c = config(); const p = new Providers(c);
  const page = normalizePage({ ...fixture, title: '<script>alert(1)</script>', sections: fixture.sections.map(s => ({ ...s, body: '<img src=x onerror=alert(1)>' })) }, 'https://a.org/', policy);
  const { spec } = await composePage(page, p.compositionEvaluator(), c);
  const html = renderToStaticMarkup(createElement(WorldView, { spec }));
  assert(!html.includes('<script>')); assert(!html.includes('<img src=')); assert(html.includes('&lt;script&gt;'));
  assert(html.includes('/view?')); assert(!html.includes('href="https://'));
});
test('all five layout hints flow through official composer and json-render', async () => {
  for (const layout of ['article', 'docs', 'forum', 'product', 'home'] as const) {
    const c = config(); const p = new Providers(c);
    const page = normalizePage(fixture, 'https://a.org/', { ...policy, layout });
    const { spec } = await composePage(page, p.compositionEvaluator(), c);
    assert(renderToStaticMarkup(createElement(WorldView, { spec })).includes(`layout-${layout}`));
  }
});
test('live mode requires TypeSafe credential and never auto-mocks', () => {
  assert.throws(() => loadConfig({}), /JEV_API_KEY/);
  assert.equal(loadConfig({ JEV_API_KEY: 'private' }).mode, 'live');
  assert.throws(() => loadConfig({ APP_MODE: 'mock', OPENAI_JSON_MODE: 'typo' }));
});
test('world namespaces separate fixture/live, epochs and models, not credentials', () => {
  const c = config();
  assert.notEqual(namespace(c), namespace({ ...c, mode: 'live' }));
  assert.notEqual(namespace(c), namespace({ ...c, epoch: '2' }));
  assert.notEqual(namespace(c), namespace({ ...c, model: 'other' }));
  assert.notEqual(namespace(c), namespace({ ...c, jevModel: 'other-jev' }));
  assert.equal(namespace(c), namespace({ ...c, key: 'rotated', jevKey: 'rotated-jev' }));
});
test('SQLite persistence is stable across restarts and does not overwrite', () => {
  const dir = mkdtempSync(join(tmpdir(), 'world-'));
  try {
    const path = join(dir, 'world.sqlite');
    const a = new Store(path, 'one'); a.put('page', 'a', { title: 'first' }); a.close();
    const b = new Store(path, 'one'); assert.deepEqual(b.put('page', 'a', { title: 'second' }), { title: 'first' }); b.close();
    const c = new Store(path, 'two'); assert.equal(c.get('page', 'a'), undefined); c.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test('complete fixture search → page → link loop uses official composer with zero network calls', async () => {
  const { store, world, providers } = harness();
  try {
    const search = await world.search('deep sea'); assert.equal(search.composition.source, 'mock');
    const first = await world.page(search.data.results[0].url); assert(first.spec.root);
    const second = await world.page(first.data.links[0].url, first.data.url, first.data.links[0].label);
    assert.notEqual(first.data.url, second.data.url); assert.equal(second.data.siteName, first.data.siteName);
    const cached = await world.page(first.data.url); assert.equal(cached.cached, true); assert.deepEqual(cached.spec, first.spec);
    assert.equal(providers.calls.length, 0);
  } finally { store.close(); }
});
test('direct TypeSafe /systemone adapter satisfies json-render evaluator contract', async () => {
  const p = liveProvider((url, body, init) => {
    assert.equal(url, 'https://api.typesafe.ai/v1/systemone');
    const headers = init.headers as Record<string, string>;
    assert.equal(headers.Authorization, 'Bearer private-jev-key');
    assert.equal(body.model, 'jev-latest');
    assert.equal(body.questions.layout.type, 'choice');
    return Response.json(choose(body.questions, body.state));
  });
  assert.equal((await p.pagePolicy({ url: 'https://a.org/' })).source, 'jev');
  assert.equal(p.calls.filter(c => c.provider === 'jev').length, 1);
});
test('direct TypeSafe evaluator rejects out-of-catalog decisions instead of fallback', async () => {
  const p = liveProvider((_url, body) => Response.json({
    answers: Object.fromEntries(Object.keys(body.questions).map(k => [k, {
      type: 'choice', choice: 'execute_js', confidence: 1, probabilities: { execute_js: 1 },
    }]))
  }));
  await assert.rejects(p.pagePolicy({ url: 'https://a.org/' }), /out-of-catalog/);
});
test('official experimental_composeSpec performs bounded select/layout evaluations', async () => {
  const p = liveProvider((url, body) => {
    if (url.endsWith('/systemone')) return Response.json(choose(body.questions, body.state));
    throw new Error('unexpected provider');
  });
  const page = normalizePage(fixture, 'https://a.org/', policy);
  const { spec, composition } = await composePage(page, p.compositionEvaluator(), p.config);
  assert(spec.root); assert.equal(composition.source, 'json-render-jev'); assert.equal(composition.stopReason, 'finish');
  assert.equal(composition.evaluations, 2); assert.equal(p.calls.filter(c => c.provider === 'jev').length, 2);
});
test('OpenAI-compatible generation sends JSON mode and optional thinking without Qwen prefill', async () => {
  const p = liveProvider((url, body) => {
    assert(url.endsWith('/chat/completions')); assert.equal(body.response_format.type, 'json_object');
    assert.equal(body.stream, false); assert.equal(body.messages.length, 2); assert.equal(body.thinking, undefined); assert.equal(body.seed, undefined);
    return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(fixture) } }] });
  });
  assert.equal((await p.page({ url: 'https://a.org/' }, policy)).title, fixture.title);
});
for (const mode of ['off', 'json_schema'] as const) {
  test(`generator supports explicit ${mode} mode`, async () => {
    const p = liveProvider((_url, body) => {
      assert.equal(body.response_format?.type, mode === 'off' ? undefined : 'json_schema');
      return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(fixture) } }] });
    });
    p.config.jsonMode = mode; await p.page({ url: 'https://a.org/' }, policy);
  });
}
test('length-truncated generation gets one doubled-budget retry, then rejects', async () => {
  const c = { ...loadConfig({ APP_MODE: 'mock', WORLD_DB: ':memory:' }), mode: 'live' as const, key: 'k' };
  const budgets: number[] = [];
  const p = new Providers(c, (async (_input: string | URL | Request, init?: RequestInit) => {
    budgets.push((JSON.parse(String(init?.body)) as { max_tokens: number }).max_tokens);
    return Response.json({ choices: [{ finish_reason: 'length', message: { content: '{"partial":true}' } }] });
  }));
  await assert.rejects(p.page({ url: 'https://a.org/' }, policy), /did not finish/);
  assert.deepEqual(budgets, [4096, 8192]);
});

test('truncated generation is rejected and not tolerated as a completed document', async () => {
  const p = liveProvider(() => Response.json({ choices: [{ finish_reason: 'length', message: { content: JSON.stringify(fixture) } }] }));
  await assert.rejects(p.page({ url: 'https://a.org/' }, policy), /did not finish/);
});
test('generator authentication errors are not retried and never echo secret bodies', async () => {
  let calls = 0;
  const p = liveProvider(() => { calls++; return new Response('private-openai-key leaked by upstream', { status: 401 }); });
  await assert.rejects(p.page({ url: 'https://a.org/' }, policy), e => { assert(!String(e).includes('private-openai-key')); return true; });
  assert.equal(calls, 1);
});
test('generator overload retry is bounded to one additional attempt', async () => {
  let calls = 0;
  const p = liveProvider((_url, body) => ++calls === 1 ? new Response('', { status: 529 }) : Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(fixture) } }] }));
  await p.page({ url: 'https://a.org/' }, policy); assert.equal(calls, 2);
});
test('simultaneous cache misses share generation; a failure remains retryable', async () => {
  let generations = 0; let fail = true;
  const p = liveProvider((url, body) => url.endsWith('/systemone') ? Response.json(choose(body.questions, body.state)) : (() => { throw new Error('unexpected network'); })());
  p.pagePolicy = async () => policy;
  p.page = async () => { generations++; await new Promise(r => setTimeout(r, 10)); if (fail) throw new Error('fixture failure'); return fixture; };
  const store = new Store(':memory:', 'dedup'); const world = new World(store, p);
  try {
    const results = await Promise.allSettled([world.page('https://a.org/'), world.page('https://a.org/')]);
    assert(results.every(r => r.status === 'rejected')); assert.equal(generations, 1); assert.equal(store.stats().page, undefined);
    fail = false;
    const successes = await Promise.all([world.page('https://a.org/'), world.page('https://a.org/')]);
    assert.equal(generations, 2); assert.deepEqual(successes[0].data, successes[1].data); assert.deepEqual(successes[0].spec, successes[1].spec);
  } finally { store.close(); }
});
test('HTTP API validates inputs, denies cross-origin calls and returns composed spec', async () => {
  const { store, world } = harness(); const running = listen(createApp(world), 0); const base = running.base;
  try {
    const post = (path: string, data: unknown, headers = {}) => fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(data) });
    assert.equal((await post('/api/page', { url: 'javascript:alert(1)' })).status, 400);
    assert.equal((await post('/api/page', { url: 'https://a.org/', baseUrl: 'https://evil.org' })).status, 400);
    assert.equal((await post('/api/search', { query: 'test' }, { Origin: 'https://evil.org' })).status, 403);
    assert.equal((await fetch(base + '/settings')).status, 404);
    const result = await post('/api/search', { query: 'deep sea' }); assert.equal(result.status, 200);
    const payload = await result.json(); assert.equal(payload.mode, 'mock'); assert(payload.spec.root); assert.equal(payload.composition.source, 'mock');
    const health = await fetch(base + '/api/health'); assert(health.headers.get('content-security-policy')?.includes("script-src 'self'"));
    assert.equal((await health.json()).upstreamConnectivity, 'not-probed');
  } finally { await running.stop(); store.close(); }
});

test('pure sha256 hash matches standard digests and prior Bun.CryptoHasher storage keys', () => {
  assert.equal(sha256Hex(''), 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
  assert.equal(sha256Hex('abc'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  for (const input of ['https://example.org/page', 'x'.repeat(200), '搜尋語句 with unicode', 'y'.repeat(55), 'z'.repeat(64)]) {
    assert.equal(key(input), new Bun.CryptoHasher('sha256').update(input).digest('hex'));
  }
});

test('decisions endpoint path is configurable and defaults to TypeSafe /systemone', () => {
  assert.equal(loadConfig({ JEV_API_KEY: 'k' }).jevPath, '/systemone');
  const openrouter = loadConfig({ JEV_API_KEY: 'k', JEV_BASE_URL: 'https://openrouter.ai/api/alpha', JEV_PATH: '/decisions' });
  assert.equal(openrouter.jevBase, 'https://openrouter.ai/api/alpha');
  assert.equal(openrouter.jevPath, '/decisions');
  assert.throws(() => loadConfig({ JEV_API_KEY: 'k', JEV_PATH: 'decisions' }), /path/);
  assert.throws(() => loadConfig({ JEV_API_KEY: 'k', JEV_PATH: '/bad path' }), /path/);
});

test('choice-chat evaluator answers Choice questions through any chat model', async () => {
  const base = loadConfig({ APP_MODE: 'mock', WORLD_DB: ':memory:' });
  const c = {
    ...base, mode: 'live' as const,
    jevProtocol: 'choice-chat' as const,
    jevBase: 'https://openrouter.ai/api/v1', jevPath: '/chat/completions',
    jevKey: 'k', jevModel: 'inception/mercury-decide:free', key: 'k',
  };
  const chatBody = {
    choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({
      answers: {
        layout: { choice: 'docs', confidence: 0.7 },
        palette: { choice: 'dark', confidence: 0.6 },
      },
    }) } }],
  };
  const p = new Providers(c, (async (input: string | URL | Request) => {
    assert.ok(String(input).endsWith('/chat/completions'));
    return Response.json(chatBody);
  }));
  const answers = await p.choices({ url: 'https://a.org/' }, {
    layout: { type: 'choice', instructions: 'Pick.', criteria: { article: 'A', docs: 'D' } },
    palette: { type: 'choice', instructions: 'Pick.', criteria: { neutral: 'N', dark: 'D' } },
  });
  assert.equal(answers.layout?.choice, 'docs');
  assert.equal(answers.palette?.choice, 'dark');
});

test('choice-chat evaluator rejects out-of-catalog choices like the systemone path', async () => {
  const base = loadConfig({ APP_MODE: 'mock', WORLD_DB: ':memory:' });
  const c = {
    ...base, mode: 'live' as const,
    jevProtocol: 'choice-chat' as const,
    jevBase: 'https://openrouter.ai/api/v1', jevPath: '/chat/completions',
    jevKey: 'k', jevModel: 'm', key: 'k',
  };
  const bad = {
    choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({
      answers: { layout: { choice: 'execute_js', confidence: 1 } },
    }) } }],
  };
  const p = new Providers(c, (async () => Response.json(bad)));
  await assert.rejects(p.choices({ url: 'https://a.org/' }, {
    layout: { type: 'choice', instructions: 'Pick.', criteria: { article: 'A', docs: 'D' } },
  }), /out-of-catalog/);
});

test('choice-chat correction retry recovers from one bad key', async () => {
  const base = loadConfig({ APP_MODE: 'mock', WORLD_DB: ':memory:' });
  const c = {
    ...base, mode: 'live' as const,
    jevProtocol: 'choice-chat' as const,
    jevBase: 'https://openrouter.ai/api/v1', jevPath: '/chat/completions',
    jevKey: 'k', jevModel: 'm', key: 'k',
  };
  const good = (choice: string) => ({
    choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({
      answers: { layout: { choice, confidence: 0.8 } },
    }) } }],
  });
  let calls = 0;
  const p = new Providers(c, (async () => Response.json(good(++calls === 1 ? 'nope' : 'docs'))));
  const answers = await p.choices({ url: 'https://a.org/' }, {
    layout: { type: 'choice', instructions: 'Pick.', criteria: { article: 'A', docs: 'D' } },
  });
  assert.equal(answers.layout?.choice, 'docs');
  assert.equal(calls, 2);
});

test('choice-chat joins the namespace without breaking the legacy default tuple', () => {
  const c = loadConfig({ APP_MODE: 'mock', WORLD_DB: ':memory:' });
  assert.equal(c.jevProtocol, 'systemone');
  assert.notEqual(namespace({ ...c, jevProtocol: 'choice-chat' }), namespace(c));
});

test('default decisions path keeps the legacy namespace (old caches stay readable)', () => {
  const c = loadConfig({ APP_MODE: 'mock', WORLD_DB: ':memory:' });
  assert.equal(c.jevPath, '/systemone');
  // Historical tuple from before JEV_PATH existed (no jevPath element).
  const legacy = sha256Hex(JSON.stringify([VERSION, c.epoch, c.mode, c.base, c.model,
    c.jevBase, c.jevModel, c.jsonMode, c.thinking, c.maxTokens, c.composeMaxSteps, c.composeMaxElements, c.composeMaxDepth]))
    .slice(0, 24);
  assert.equal(namespace(c), legacy);
  assert.notEqual(namespace({ ...c, jevPath: '/decisions' }), legacy);
});

class MemoryStorage implements Storage {
  private map = new Map<string, string>();
  get length() { return this.map.size; }
  key(index: number) { return [...this.map.keys()][index] ?? null; }
  getItem(k: string) { return this.map.get(k) ?? null; }
  setItem(k: string, v: string) { this.map.set(k, v); }
  removeItem(k: string) { this.map.delete(k); }
  clear() { this.map.clear(); }
}

test('browser LocalStore persists per namespace with insert-or-ignore semantics', () => {
  const storage = new MemoryStorage();
  const a = new LocalStore('ns-one', storage);
  assert.deepEqual(a.put('page', 'p1', { title: 'first' }), { title: 'first' });
  assert.deepEqual(a.put('page', 'p1', { title: 'second' }), { title: 'first' });
  assert.deepEqual(a.get('page', 'p1'), { title: 'first' });
  assert.deepEqual(a.stats(), { page: 1 });
  const reopened = new LocalStore('ns-one', storage);
  assert.deepEqual(reopened.get('page', 'p1'), { title: 'first' });
  const otherWorld = new LocalStore('ns-two', storage);
  assert.equal(otherWorld.get('page', 'p1'), undefined);
  a.close();
});

test('LocalStore instances preserve different records with per-record keys', () => {
  const storage = new MemoryStorage();
  const tabA = new LocalStore('ns-shared', storage);
  const tabB = new LocalStore('ns-shared', storage);
  tabA.put('page', 'from-a', { title: 'a' });
  tabB.put('page', 'from-b', { title: 'b' });
  tabA.put('search', 'q', { results: [] });
  assert.deepEqual(tabA.get('page', 'from-b'), { title: 'b' });
  assert.deepEqual(tabB.get('page', 'from-a'), { title: 'a' });
  assert.deepEqual(tabA.stats(), { page: 2, search: 1 });
});

test('provider cancellation during fetch settles before the request timeout', async () => {
  const c = { ...config(), mode: 'live' as const, timeout: 120000, key: 'fixture-only' };
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  let calls = 0;
  const p = new Providers(c, async (_input, init) => {
    calls++;
    const signal = init?.signal;
    assert.ok(signal);
    signal.throwIfAborted();
    return new Promise<Response>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      entered();
    });
  });
  const controller = new AbortController();
  const pending = p.post('openai', 'https://fixture.invalid/', 'fixture-only', {}, controller.signal);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bounded = <T,>(promise: Promise<T>) => Promise.race([promise, new Promise<T>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error('cancellation watchdog expired')), 2000);
  })]);
  // Install the rejection handler before triggering cancellation.
  const rejected = assert.rejects(bounded(pending), /request cancelled/);
  try {
    await started;
    controller.abort();
    await rejected;
    assert.equal(calls, 1);
  } finally { controller.abort(); clearTimeout(timer); }
});

test('pre-aborted world search does not start policy, generation or composition', async () => {
  const c = { ...loadConfig({ APP_MODE: 'mock', WORLD_DB: ':memory:' }), mode: 'live' as const, key: 'k' };
  const abortedFlags: Array<boolean | undefined> = [];
  const providers = new Providers(c, (async (_input: string | URL | Request, init?: RequestInit) => {
    const signal = init?.signal as AbortSignal | undefined;
    abortedFlags.push(signal?.aborted);
    throw new Error('A pre-aborted World request must not enter the provider');
  }));
  const store = new Store(':memory:', 'abort-probe');
  const world = new World(store, providers);
  try {
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(world.search('deep sea', controller.signal));
    assert.equal(abortedFlags.length, 0);
    assert.equal(store.stats().search, undefined);
  } finally { store.close(); }
});

test('saveSettings survives denied storage and still applies to the session', () => {
  const throwing = new MemoryStorage();
  throwing.setItem = () => { throw new Error('denied'); };
  (globalThis as Record<string, unknown>).localStorage = throwing;
  try {
    const saved = saveSettings({ ...defaultSettings(), apiKey: ' k ', forceBrowser: true });
    assert.equal(saved.persisted, false);
    assert.equal(saved.settings.apiKey, 'k');
    assert.equal(saved.settings.forceBrowser, true);
    const reading = new MemoryStorage();
    (globalThis as Record<string, unknown>).localStorage = reading;
    const kept = saveSettings({ ...defaultSettings(), apiKey: ' k ' });
    assert.equal(kept.persisted, true);
    assert.deepEqual(loadSettings().apiKey, 'k');
  } finally {
    delete (globalThis as Record<string, unknown>).localStorage;
  }
});
