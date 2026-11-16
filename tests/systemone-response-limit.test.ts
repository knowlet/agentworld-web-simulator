import { test } from 'bun:test';
import assert from 'node:assert/strict';
import { Providers } from '../src/providers';
import { loadConfig } from '../src/config';

const limit = 2_000_000;
const payload = { answers: { decision: {
  type: 'choice', choice: 'yes', confidence: 1, probabilities: { yes: 1 },
} }, padding: '' };
const questions = { decision: { type: 'choice' as const, instructions: 'Choose', criteria: { yes: 'yes' } } };
function bytes(length: number) {
  const empty = JSON.stringify(payload);
  return new TextEncoder().encode(JSON.stringify({ ...payload, padding: 'x'.repeat(length - empty.length) }));
}
function provider(response: Response) {
  return new Providers({ ...loadConfig({ APP_MODE: 'mock' }), mode: 'live' }, async () => response);
}

for (const header of [undefined, '1']) {
  test(`System One rejects oversized streamed JSON with content-length ${header}`, async () => {
    const data = bytes(limit + 100_000);
    let offset = 0;
    let cancelled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset === data.length) { controller.close(); return; }
        const end = Math.min(offset + 65536, data.length);
        controller.enqueue(data.slice(offset, end)); offset = end;
      },
      cancel() { cancelled = true; },
    });
    const p = provider(new Response(stream, { headers: header ? { 'Content-Length': header } : {} }));
    await assert.rejects(p.choices({}, questions), /response too large/);
    assert.equal(cancelled, true);
    assert.equal(p.calls.length, 0);
  });
}

test('System One accepts a valid response exactly at the byte limit', async () => {
  const p = provider(new Response(bytes(limit)));
  const result = await p.choices({}, questions);
  assert.equal(result.decision?.choice, 'yes');
});

test('System One counts UTF-8 bytes rather than characters', async () => {
  const p = provider(Response.json({ ...payload, padding: '界'.repeat(700_000) }));
  await assert.rejects(p.choices({}, questions), /response too large/);
  assert.equal(p.calls.length, 0);
});

test('System One keeps malformed JSON and empty responses as failures', async () => {
  for (const response of [new Response('{'), new Response(null)]) {
    const p = provider(response);
    await assert.rejects(p.choices({}, questions), /invalid System One response/);
    assert.equal(p.calls.length, 0);
  }
});
