import { test, expect } from 'bun:test';
import { pageDraftSchema, searchSchema } from '../src/domain';

// GHSA-mrhx-c7xc-m3w5: an upper bound must reject an oversized generated
// collection before per-element validation allocates an issue for every item.
// Small deterministic fixtures prove the behavior without exhausting memory.
const cases = [
  { name: 'page sections', schema: pageDraftSchema.shape.sections, min: 2, max: 12,
    valid: { heading: 'Heading', kind: 'text', body: 'Body' } },
  { name: 'page links', schema: pageDraftSchema.shape.links, min: 3, max: 16,
    valid: { label: 'Link', url: 'https://example.org/' } },
  { name: 'search results', schema: searchSchema.shape.results, min: 4, max: 9,
    valid: { title: 'Result', url: 'https://example.org/', snippet: 'Snippet' } },
  { name: 'related searches', schema: searchSchema.shape.related, min: 1, max: 4,
    valid: 'Related query' },
];

for (const { name, schema, min, max, valid } of cases) {
  test(`${name}: oversized invalid collection yields only the size issue`, () => {
    const result = schema.safeParse(Array.from({ length: 64 }, () => null));
    expect(result.success).toBe(false);
    if (result.success) throw new Error('Oversized collection accepted');
    expect(result.error.issues).toHaveLength(1);
    expect(result.error.issues[0]).toMatchObject({ code: 'too_big', maximum: max, path: [] });
  });

  test(`${name}: oversized collection is rejected without reading its elements`, () => {
    const input = new Array(max + 1);
    let reads = 0;
    Object.defineProperty(input, 0, { get() { reads++; return valid; } });
    expect(schema.safeParse(input).success).toBe(false);
    expect(reads).toBe(0);
  });

  test(`${name}: boundary and within-bound element validation stay intact`, () => {
    expect(schema.safeParse(Array.from({ length: min }, () => valid)).success).toBe(true);
    expect(schema.safeParse(Array.from({ length: max }, () => valid)).success).toBe(true);
    expect(schema.safeParse(Array.from({ length: min - 1 }, () => valid)).success).toBe(false);
    expect(schema.safeParse(Array.from({ length: max + 1 }, () => valid)).success).toBe(false);
    expect(schema.safeParse(Array.from({ length: min }, () => null)).success).toBe(false);
  });
}
