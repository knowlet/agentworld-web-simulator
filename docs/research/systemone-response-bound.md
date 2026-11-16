# Bound System One provider responses before JSON parsing

Base: e6608465fe7b07b1324836c5fad5f8dc31186e3c.

The generator/choice-chat POST path already caps response bodies at 2,000,000
bytes, but the direct System One evaluator called Response.json() without a byte
limit. A valid response with a large ignored extra field was accepted, allowing
unbounded buffering/parsing before schema validation.

Apply the same 2,000,000-byte cap to the direct evaluator. Count actual streamed
bytes, not Content-Length or characters; cancel an oversized stream, release its
reader lock and report a fixed ProviderError without response content. Preserve
existing Choice validation, timeouts, retry behavior, and successful call metrics.
No request-input or dependency changes are included (separate PRs #5/#6).

Offline tests use injected synthetic responses, never a real provider:
- Oversized valid JSON with absent or false-small Content-Length is rejected and
  its stream is cancelled. Both cases were accepted on the unmodified base.
- Valid JSON exactly at the limit succeeds.
- Multibyte UTF-8 exceeds the byte cap even with fewer characters.
- Malformed JSON and empty responses remain failures.

This bounds the bytes retained before parsing; it cannot prevent a transport from
allocating an oversized individual chunk before handing that chunk to the reader.
No live model/API/secret is used, and no workflow or deployment change is made.
