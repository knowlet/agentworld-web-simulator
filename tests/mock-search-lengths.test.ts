import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config';
import { searchSchema } from '../src/domain';
import { Providers } from '../src/providers';
import { createApp } from '../src/server';
import { key, Store } from '../src/store';
import { World } from '../src/world';

// Longest mock host prefix is 38 units (`https://journal.simulated.test/topics/`)
// and the index suffix is 2. The summary field is 600 units with a 28-unit
// wrapper, so a literal URL may be at most 572 units (encoded slug <= 532).
// "查" percent-encodes to 9 units, so 59 fit (531) and 60 do not (540).
const LITERAL_CHINESE = '查'.repeat(59);
const OVER_LITERAL_CHINESE = '查'.repeat(60);

function harness() {
  const config = loadConfig({ APP_MODE: 'mock', WORLD_DB: ':memory:' });
  const store = new Store(':memory:', 'mock-search-lengths');
  const providers = new Providers(config, async () => { throw new Error('Network forbidden'); });
  return { store, providers, world: new World(store, providers) };
}

for (const [name, query] of [
  ['existing boundary', 'x'.repeat(171)],
  ['first rejected length', 'x'.repeat(172)],
  ['title boundary', 'x'.repeat(200)],
  ['maximum ASCII query', 'x'.repeat(500)],
  ['literal multi-byte URL boundary', LITERAL_CHINESE],
  ['multi-byte URL over literal budget', OVER_LITERAL_CHINESE],
  ['two hundred Chinese', '查'.repeat(200)],
  ['maximum Chinese query', '查'.repeat(500)],
  ['maximum emoji query', '😀'.repeat(250)],
  ['surrogate truncation boundary', 'x'.repeat(169) + '😀' + 'y'.repeat(10)],
] as const) {
  test(`mock search materializes and caches ${name}`, async () => {
    const { store, providers, world } = harness();
    try {
      const result = await world.search(query);
      assert.equal(result.data.query, query);
      assert.equal(result.mode, 'mock');
      assert.equal(result.cached, false);
      assert.ok(result.spec.root);
      searchSchema.parse({ results: result.data.results, related: result.data.related });
      assert.equal(new Set(result.data.results.map(r => r.url)).size, 6);
      assert.equal(new Set(result.data.related).size, 2);
      if (name === 'literal multi-byte URL boundary') {
        assert.ok(result.data.results[0]!.url.includes(encodeURIComponent(query)));
        assert.ok(!result.data.results[0]!.url.includes('/_sha256/'));
        assert.ok(Math.max(...result.data.results.map(r => r.url.length)) <= 572);
      }
      if (name === 'multi-byte URL over literal budget' || name === 'two hundred Chinese') {
        assert.ok(result.data.results[0]!.url.includes(`/topics/_sha256/${key(query)}-0`));
      }
      for (const { title, url, snippet } of result.data.results) {
        assert.doesNotThrow(() => encodeURIComponent(title));
        assert.ok(url.length <= 2048);
        assert.ok(snippet.includes(query));
        assert.equal(new URL(url).protocol, 'https:');
      }
      for (const suggestion of result.data.related) assert.doesNotThrow(() => encodeURIComponent(suggestion));
      assert.ok(result.data.related[0]!.endsWith(' history'));
      assert.ok(result.data.related[1]!.endsWith(' examples'));
      assert.ok(Object.values(result.spec.elements).some(element =>
        element.type === 'Header' && element.props.title === query));
      const cached = await world.search(query);
      assert.equal(cached.cached, true);
      assert.deepEqual(cached.data, result.data);
      assert.deepEqual(cached.spec, result.spec);
      assert.equal(providers.calls.length, 0);
      assert.equal(store.stats().search, 1);
    } finally { store.close(); }
  });
}

test('mock search keeps short-query labels and URLs unchanged', async () => {
  const { store, world } = harness();
  try {
    const result = await world.search('deep sea');
    assert.equal(result.data.results[0]!.title, 'deep sea — atlas');
    assert.equal(result.data.results[0]!.url, 'https://atlas.simulated.test/topics/deep%20sea-0');
    assert.deepEqual(result.data.related, ['deep sea history', 'deep sea examples']);
  } finally { store.close(); }
});

test('long Unicode queries retain distinct cache and URL identities', async () => {
  const { store, world } = harness();
  const prefix = '查'.repeat(499);
  try {
    const a = await world.search(prefix + '甲');
    const b = await world.search(prefix + '乙');
    assert.notEqual(a.data.results[0]!.url, b.data.results[0]!.url);
    assert.ok(a.data.results[0]!.url.includes(key(prefix + '甲')));
    assert.ok(b.data.results[0]!.url.includes(key(prefix + '乙')));
    const literalDigest = await world.search(key(prefix + '甲'));
    assert.notEqual(a.data.results[0]!.url, literalDigest.data.results[0]!.url);
    assert.equal(store.stats().search, 3);
  } finally { store.close(); }
});

test('HTTP search accepts valid long queries and rejects over-limit input', async () => {
  const { store, world } = harness();
  const app = createApp(world);
  const send = (query: string) => app(new Request('http://127.0.0.1/api/search', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query }),
  }));
  const openPage = (url: string, ctx?: string) => app(new Request('http://127.0.0.1/api/page', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(ctx === undefined ? { url } : { url, ctx }),
  }));
  try {
    const atLimit = await send('查'.repeat(500));
    assert.equal(atLimit.status, 200);
    const atBody = await atLimit.json();
    assert.equal(atBody.data.query, '查'.repeat(500));
    const atPage = await openPage(atBody.data.results[0].url, atBody.data.results[0].title);
    assert.equal(atPage.status, 200);

    const twoHundred = await send('查'.repeat(200));
    assert.equal(twoHundred.status, 200);
    const twoHundredBody = await twoHundred.json();
    assert.ok(twoHundredBody.data.results[0].url.includes('/_sha256/'));
    assert.equal((await openPage(twoHundredBody.data.results[0].url, twoHundredBody.data.results[0].title)).status, 200);
    assert.equal((await openPage(twoHundredBody.data.results[0].url)).status, 200);

    const literal = await send(LITERAL_CHINESE);
    assert.equal(literal.status, 200);
    const literalBody = await literal.json();
    assert.ok(literalBody.data.results[0].url.includes(encodeURIComponent(LITERAL_CHINESE)));
    assert.equal((await openPage(literalBody.data.results[0].url)).status, 200);
    const overLiteral = await send(OVER_LITERAL_CHINESE);
    assert.equal(overLiteral.status, 200);
    const overBody = await overLiteral.json();
    assert.ok(overBody.data.results[0].url.includes('/_sha256/'));
    assert.equal((await openPage(overBody.data.results[0].url)).status, 200);

    const ascii = await send('x'.repeat(500));
    assert.equal(ascii.status, 200);
    const asciiBody = await ascii.json();
    assert.ok(!asciiBody.data.results[0].url.includes('/_sha256/'));
    assert.equal((await openPage(asciiBody.data.results[0].url)).status, 200);

    const over = await send('查'.repeat(501));
    assert.equal(over.status, 400);
    assert.deepEqual(await over.json(), { error: 'Search must contain 1–500 characters' });
    const overAscii = await send('x'.repeat(501));
    assert.equal(overAscii.status, 400);
    assert.deepEqual(await overAscii.json(), { error: 'Search must contain 1–500 characters' });
    const overEmoji = await send('😀'.repeat(251));
    assert.equal(overEmoji.status, 400);
    assert.deepEqual(await overEmoji.json(), { error: 'Search must contain 1–500 characters' });
    await assert.rejects(world.search('查'.repeat(501)), /1–500/);
    assert.equal(store.stats().search, 5);
  } finally { store.close(); }
});
