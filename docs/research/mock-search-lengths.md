# Mock search output lengths

## Scope and observed failure

On 2026-11-05, default branch `e6608465fe7b07b1324836c5fad5f8dc31186e3c` accepts normalized search queries of 1–500 JavaScript string units in both `World.search` and the HTTP schema. Its deterministic mock then embeds the full query in titles, related suggestions, and result URLs. A 171-unit ASCII query succeeds; 172 units fails the related suggestion limit of 180, and 200/500 units also exceed the title limit of 200. Percent-encoded long Unicode queries can exceed the 2048-unit URL limit.

## Source comparison and decision

| Source | Evidence | Use |
| --- | --- | --- |
| Existing `src/domain.ts` / `src/world.ts` | Search input and generated document have different bounded fields. | Keep the public input range and output schemas; repair mock generation. |
| Zod 4.3.6, MIT | `$ZodCheckMaxLength` compares `input.length` to the maximum and reports `too_big`; it does not truncate strings. | Continue using the installed validator. No new dependency or copied implementation. |

Targeted upstream repository search found `colinhacks/zod`. The actual [maximum-length check](https://github.com/colinhacks/zod/blob/ca3c8629c0c2715571f70b44c2433cad3db7fe4e/packages/zod/src/v4/core/checks.ts#L592-L643) and [MIT license](https://github.com/colinhacks/zod/blob/ca3c8629c0c2715571f70b44c2433cad3db7fe4e/LICENSE) were read at the installed version's commit. This is a narrow application bug, so replacing Zod or weakening its bounds is not warranted.

Shorten only the mock label query to at most 171 UTF-16 units, reserving the existing longest suffix (` examples`, nine units). Do not split a surrogate pair when truncating. Preserve the complete normalized query in the document, cache identity, heading, and snippets. Length checks use UTF-16 code units (`String.length`), the same comparison as Zod's `$ZodCheckMaxLength`. They do not use UTF-8 bytes or percent-encoded length. A literal result slug is kept only when every generated result URL is at most 572 units. The 600-unit page summary wraps the URL in `A fictional observation at ` and `.` (28 units); that budget is tighter than the 2048-unit URL field and the `/topic-N` link suffix. Mock page titles and summaries are bounded to 200 and 600 units so a valid URL is not reported as an invalid generated document. Otherwise the existing SHA-256 key is used under a separate `_sha256/` path segment. 200 `查` encode to exactly 1800 ASCII units, but the resulting URL is 1838 units on `atlas` and 1840 on `journal`/`archive`, so that query uses the hash path. Search and the following page both return HTTP 200. Queries outside 1–500 UTF-16 units return HTTP 400 with `Search must contain 1–500 characters`. Different long queries retain different URL identities; the separate path segment avoids a collision with a literal digest query. Lone-surrogate input rejection/normalization is a separate pre-existing input-contract question, not changed here. No schema, dependency, namespace, provider, live generation, or short-query behavior changes.

## Validation plan

Run the new tests against the unchanged source first. Cover the 171/172 transition, 200/500 ASCII queries, long Chinese and emoji queries, a surrogate pair at the truncation boundary, different long-query identities, cache replay, HTTP success for a valid long query, and continued rejection above 500. Then run the repository's frozen install, archive verification, typecheck, build, unit/contracts, and browser checks. These use synthetic offline fixtures; no real provider call is needed.
