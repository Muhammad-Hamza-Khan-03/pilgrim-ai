# Phase 4D Task Contract — provider-neutral deterministic streaming (SSE) transport seam

## Objective
Add the smallest streaming seam to `@pilgrim/widget`: a safe `text/event-stream` parser and a dependency-injected stream transport, consumable by the Phase 4C chat panel. Deterministic, provider-neutral, no live I/O.

## Inputs (injected only)
- `open({ message, signal }) => Promise<AsyncIterable<string>>`: yields decoded text pieces of an event stream. Production would adapt `fetch` body streams at the edge; tests use fixture async generators. The seam never reads `globalThis.fetch`, `EventSource`, or any endpoint.
- Optional injected `timer` (`{ set, clear }`, defaults to `setTimeout`/`clearTimeout`) so timeout tests are deterministic.

## Wire format (SSE subset)
- Line endings `\n`, `\r\n`, `\r`, possibly split across pieces. `:` comment lines ignored; only `event` and `data` fields are used (multi-line `data` joined with `\n`); other fields ignored.
- `event: chunk`, data `{"text": string}` → message chunk, appended in arrival order.
- `event: done`, data empty or `{}` → completion; reading stops, later input is ignored.
- Malformed → `ChatClientError('malformed_stream')`, never thrown past the panel: unknown/missing event name, non-JSON or wrong-shape data, an event/line over 64 KiB, total text over 1 MiB, or the stream ending without `done` (truncated).

## Behavior
- Result: `streamChat` calls `onChunk(text)` per chunk and resolves to the concatenated text on `done`.
- Abort: caller `AbortSignal` (already or later aborted) rejects with `aborted`; no retry; the in-flight iterator is closed via `return()`. The panel aborts on close/Escape and shows no error.
- Timeout: `timeoutMs` (default 30000) applies to opening and to each wait for the next piece; expiry aborts the attempt and rejects `timeout`.
- Error: `open`/iterator throws → `network_error` (message not leaked).
- Retry: `retries` (default 0). Only `network_error`/`timeout` that occur **before any chunk was delivered** are retried, immediately (no backoff), up to `retries` extra attempts. Malformed and aborted are never retried. After a mid-stream failure the panel's Retry button re-runs the turn (no duplicate user turn; the partial assistant text is reset).
- Deterministic: no randomness, clocks, or network except the injected timer/open.

## Panel wiring
`mountPanel` accepts an optional `stream(message, onChunk, signal) => Promise<unknown>`; when given it is used instead of `client.send`, rendering one assistant message that grows as chunks arrive (text nodes only). Launcher and a11y behavior unchanged. The browser auto-run in `index.ts` does **not** wire a stream (no endpoint contract exists).

## Exclusions
Live providers/credentials/real LLMs, a server-side SSE endpoint, `fetch`/`EventSource` wiring, persistence, booking side effects, cards/chips, deployment/publishing, Phase 5. Remaining: live adapter, backend SSE contract, device/screen-reader validation.

## Acceptance
Focused tests for parsing (split pieces, CRLF, comments, multi-line data), chunk accumulation/completion, malformed events, abort, timeout, error, retry, and panel streaming; regenerated bundle artifacts match the build; widget tests/typecheck/build pass.
