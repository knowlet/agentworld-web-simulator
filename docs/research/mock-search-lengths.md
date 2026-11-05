# Mock search output lengths

## Scope and observed failure

On 2026-11-05, default branch `e6608465fe7b07b1324836c5fad5f8dc31186e3c` accepts normalized search queries of 1–500 JavaScript string units in both `World.search` and the HTTP schema. Its deterministic mock then embeds the full query in titles, related suggestions, and result URLs. A 171-unit ASCII query succeeds; 172 units fails the related suggestion limit of 180, and 200/500 units also exceed the title limit of 200. Percent-encoded long Unicode queries can exceed the 2048-unit URL limit.

## Source comparison and decision

| Source | Evidence | Use |
| --- | --- | --- |
| Existing `src/domain.ts` / `src/world.ts` | Search input and generated document have different bounded fields. | Keep the public input range and output schemas; repair mock generation. |
| Zod 4.3.6, MIT | `$ZodCheckMaxLength` compares `input.length` to the maximum and reports `too_big`; it does not truncate strings. | Continue using the installed validator. No new dependency or copied implementation. |

Targeted upstream repository search found `colinhacks/zod`. The actual [maximum-length check](https://github.com/colinhacks/zod/blob/ca3c8629c0c2715571f70b44c2433cad3db7fe4e/packages/zod/src/v4/core/checks.ts#L592-L643) and [MIT license](https://github.com/colinhacks/zod/blob/ca3c8629c0c2715571f70b44c2433cad3db7fe4e/LICENSE) were read at the installed version's commit. This is a narrow application bug, so replacing Zod or weakening its bounds is not warranted.

Shorten only the mock label query to at most 171 UTF-16 units, reserving the existing longest suffix (` examples`, nine units). Do not split a surrogate pair when truncating. Preserve the complete normalized query in the document, cache identity, heading, and snippets. Keep existing result URLs when the encoded slug fits; use the existing full SHA-256 storage key under a separate `_sha256/` path segment when the slug exceeds 1800 units, leaving room for the fixed host/path/suffix under the 2048-unit URL contract. Different long queries retain different URL identities; the separate path segment avoids a collision with a literal digest query. Lone-surrogate input rejection/normalization is a separate pre-existing input-contract question, not changed here. No schema, dependency, namespace, provider, live generation, or short-query behavior changes.

## Validation plan

Run the new tests against the unchanged source first. Cover the 171/172 transition, 200/500 ASCII queries, long Chinese and emoji queries, a surrogate pair at the truncation boundary, different long-query identities, cache replay, HTTP success for a valid long query, and continued rejection above 500. Then run the repository's frozen install, archive verification, typecheck, build, unit/contracts, and browser checks. These use synthetic offline fixtures; no real provider call is needed.
