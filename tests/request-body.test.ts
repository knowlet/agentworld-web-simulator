import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { createApp, listen } from '../src/server';
import type { World } from '../src/world';

const encode = (text: string) => new TextEncoder().encode(text);
function fixture() {
  const queries: string[] = [];
  const app = createApp({
    providers: { config: { host: 'localhost' } },
    search: async (query: string) => { queries.push(query); return { query }; },
  } as unknown as World);
  return { app, queries };
}
function request(chunks: Uint8Array[], options: { length?: string; cancel?: () => Promise<void>; readError?: boolean } = {}) {
  let reads = 0, cancels = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      reads++;
      if (options.readError) { controller.error(new Error('synthetic read failure')); return; }
      const chunk = chunks.shift();
      if (chunk) controller.enqueue(chunk); else controller.close();
    },
    cancel() { cancels++; return options.cancel?.(); },
  }, { highWaterMark: 0 });
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (options.length !== undefined) headers['Content-Length'] = options.length;
  const req = new Request('http://localhost/api/search', { method: 'POST', headers, body: stream });
  return { req, stream, reads: () => reads, cancels: () => cancels };
}
for (const length of [undefined, '1', 'nonsense', '-1', 'Infinity']) {
  test(`body: stops reading over limit with Content-Length ${length}`, async () => {
    const { app, queries } = fixture();
    const input = request([new Uint8Array(8192), new Uint8Array(8192), new Uint8Array(1), new Uint8Array(8192)], { length });
    assert.equal((await app(input.req)).status, 413);
    assert.equal(input.reads(), 3);
    assert.equal(input.cancels(), 1);
    assert.equal(input.stream.locked, false);
    assert.deepEqual(queries, []);
  });
}
test('body: declared oversize rejects without reading', async () => {
  const { app } = fixture(); const input = request([encode('{}')], { length: '16385' });
  assert.equal((await app(input.req)).status, 413); assert.equal(input.reads(), 0);
});
for (const size of [16383, 16384, 16385]) {
  test(`body: exact byte boundary ${size}`, async () => {
    const { app } = fixture(); const bytes = encode('{"query":"ok"}' + ' '.repeat(size - 14));
    assert.equal(bytes.length, size);
    const input = request([bytes.subarray(0, 8192), bytes.subarray(8192)]);
    assert.equal((await app(input.req)).status, size > 16384 ? 413 : 200);
    assert.equal(input.stream.locked, false);
  });
}
test('body: preserves split UTF-8 and empty chunks', async () => {
  const { app, queries } = fixture(); const bytes = encode('{"query":"台灣😀"}');
  const input = request([new Uint8Array(), ...Array.from(bytes, b => new Uint8Array([b]))]);
  assert.equal((await app(input.req)).status, 200); assert.deepEqual(queries, ['台灣😀']);
  assert.equal(input.stream.locked, false);
});
for (const body of ['', '{', '{"query":4}']) {
  test(`body: invalid JSON/schema ${JSON.stringify(body)}`, async () => {
    const { app } = fixture(); const input = request([encode(body)]);
    assert.equal((await app(input.req)).status, 400); assert.equal(input.stream.locked, false);
  });
}
test('body: read error retains 500 and releases lock/slot', async () => {
  const { app } = fixture();
  for (let i = 0; i < 9; i++) {
    const input = request([], { readError: true });
    assert.equal((await app(input.req)).status, 500); assert.equal(input.stream.locked, false);
  }
  assert.equal((await app(request([encode('{"query":"ok"}')]).req)).status, 200);
});
for (const kind of ['reject', 'pending'] as const) {
  test(`body: ${kind} cancellation cannot mask 413 or hold slots`, async () => {
    const { app } = fixture();
    for (let i = 0; i < 9; i++) {
      const input = request([new Uint8Array(16385), new Uint8Array(1)], {
        cancel: () => kind === 'reject' ? Promise.reject(new Error('synthetic cancel failure')) : new Promise(() => {}),
      });
      assert.equal((await app(input.req)).status, 413);
      assert.equal(input.reads(), 1); assert.equal(input.cancels(), 1); assert.equal(input.stream.locked, false);
    }
    assert.equal((await app(request([encode('{"query":"ok"}')]).req)).status, 200);
  }, 1000);
}

test('body: localhost streamed rejection preserves the HTTP response and later requests', async () => {
  const { app, queries } = fixture();
  const running = listen(app, 0);
  try {
    const input = request([new Uint8Array(8192), new Uint8Array(8193), new Uint8Array(8192)]);
    const rejected = await fetch(running.base + '/api/search', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: input.req.body,
    });
    assert.equal(rejected.status, 413);
    assert.deepEqual(await rejected.json(), { error: 'Request too large' });
    assert.deepEqual(queries, []);
    const accepted = await fetch(running.base + '/api/search', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"query":"synthetic"}',
    });
    assert.equal(accepted.status, 200);
    assert.deepEqual(queries, ['synthetic']);
  } finally { await running.stop(); }
});
