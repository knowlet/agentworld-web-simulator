import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadConfig, namespace } from '../src/config';
import { canonicalUrl } from '../src/domain';
import { Providers } from '../src/providers';
import { createApp } from '../src/server';
import { Store } from '../src/store';
import { World } from '../src/world';
import { WorldView } from '../ui/registry';

function harness() {
  const config = loadConfig({ APP_MODE: 'mock', WORLD_DB: ':memory:' });
  const store = new Store(':memory:', namespace(config));
  const providers = new Providers(config, async () => { throw new Error('Network forbidden'); });
  return { store, providers, world: new World(store, providers) };
}

for (const segment of ['%', '%2', '%GG', '%FF', '%C3%28', '%ED%A0%80', 'hello%20world%FF']) {
  test(`mock page preserves undecodable title segment ${segment}`, async () => {
    const { store, providers, world } = harness();
    try {
      const url = `https://fixture.example/${segment}?keep=%FF#fragment`;
      const canonical = canonicalUrl(url);
      const first = await world.page(url);
      assert.equal(first.data.title, segment);
      assert.equal(first.data.url, canonical);
      assert.equal(first.cached, false);
      assert.ok(first.spec.root);
      const cached = await world.page(canonical);
      assert.equal(cached.cached, true);
      assert.deepEqual(cached.data, first.data);
      assert.deepEqual(cached.spec, first.spec);
      assert.deepEqual(store.stats(), { page: 1, site: 1 });
      assert.equal(providers.calls.length, 0);
    } finally { store.close(); }
  });
}

for (const [segment, title] of [
  ['ocean', 'ocean'], ['deep%20sea', 'deep sea'],
  ['%E6%B5%B7%F0%9F%8C%8A', '海🌊'], ['%2520', '%20'],
  ['%2F', '/'], ['', 'fixture.example'],
]) {
  test(`mock page keeps existing title decoding for ${segment || '(root)'}`, async () => {
    const { store, world } = harness();
    try { assert.equal((await world.page(`https://fixture.example/${segment}`)).data.title, title); }
    finally { store.close(); }
  });
}

test('mock page keeps click context ahead of an undecodable path', async () => {
  const { store, world } = harness();
  try { assert.equal((await world.page('https://fixture.example/%FF', '', 'Clicked title')).data.title, 'Clicked title'); }
  finally { store.close(); }
});

test('HTTP page accepts percent paths and preserves navigation and cached identity', async () => {
  const { store, world } = harness();
  try {
    const app = createApp(world);
    const url = 'https://fixture.example/%FF';
    const request = () => new Request('http://127.0.0.1/api/page', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }),
    });
    const response = await app(request());
    assert.equal(response.status, 200);
    const first = await response.json();
    assert.equal(first.data.title, '%FF');
    const next = await world.page(first.data.links[0].url, url, first.data.links[0].label);
    assert.equal(next.data.title, 'Explore topic 1');
    assert.equal(next.data.url, `${url}/topic-1`);
    const revisit = await app(request());
    assert.equal(revisit.status, 200);
    const cached = await revisit.json();
    assert.equal(cached.cached, true);
    assert.deepEqual(cached.data, first.data);
    assert.deepEqual(cached.spec, first.spec);
  } finally { store.close(); }
});

test('renderer preserves the encoded text of undecodable mock titles', async () => {
  const { store, world } = harness();
  try {
    const result = await world.page('https://fixture.example/%3Cscript%3E%FF');
    assert.equal(result.data.title, '%3Cscript%3E%FF');
    const html = renderToStaticMarkup(createElement(WorldView, { spec: result.spec }));
    assert.ok(html.includes('%3Cscript%3E%FF'));
    assert.ok(!html.includes('<script>'));
    assert.ok(!html.includes('href="https://'));
  } finally { store.close(); }
});
