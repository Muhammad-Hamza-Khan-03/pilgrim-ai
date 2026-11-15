# Phase 4C Task Contract — accessible provider-neutral chat panel seam

## Objective
Add the smallest browser chat-panel UI seam to the existing `@pilgrim/widget` bundle. It must be provider-neutral, deterministic in tests, and use injected transport/fetch only. The panel is a local UI contract, not a live provider integration.

## In scope
- Shadow DOM (or equivalent isolated mount) for panel markup and styles.
- Native keyboard controls: real button/form/textarea semantics, Enter submit, Escape close, and focus behavior without custom key traps.
- ARIA semantics: dialog labeling, live status/region, named controls, expanded/hidden state, and message roles/labels.
- Deterministic message rendering for user and assistant turns, with safe text rendering (no raw HTML).
- Loading and typed error states, retry-capable UI behavior where supported by the injected transport.
- Injected `fetch`/transport and deterministic fixtures only; reuse the existing provider-neutral chat client contract where practical.
- Focused unit tests for isolation, semantics, keyboard actions, rendering, loading/error behavior, and no unintended network calls.
- Reproducible browser/widget bundle build artifacts as required by the existing build path.

## Explicit exclusions
- Live providers, cloud/network credentials, real LLMs, SSE/streaming, persistence/session storage, booking side effects, cards/chips, booking flow, deployment, publishing, production, or Phase 5 work.
- Mobile/device certification, screen-reader certification, Lighthouse evidence; report these as remaining validation.
- Changes outside the widget source/tests/build outputs and this contract unless required by the existing bundle integration.

## Acceptance criteria
1. Existing launcher lazy activation remains intact; opening the launcher mounts an isolated chat panel without provider calls until a user submits a message.
2. Panel has a deterministically testable accessible dialog surface with close control, labelled input, submit control, live loading/status region, and message list.
3. User and assistant messages render as text nodes with stable roles/labels; malformed or failed transport results surface a user-visible, non-throwing error state.
4. The implementation accepts injected fetch/transport and all tests use deterministic fixtures; no global fetch or live endpoint is used by tests.
5. Focused widget tests and existing widget tests/typecheck/build pass; generated bundle metadata matches generated files.
6. No persistence, booking, SSE, provider, deployment, force operation, or unrelated repository change is introduced.

## Implementation/QA protocol
- Implementation: delegated Claude Code worker in this worktree, constrained to this contract.
- Manager records exact candidate SHA and changed-file manifest after implementation.
- Independent QA runs read-only against that exact immutable SHA and ends with `QA VERDICT: PASS`, `FAIL`, or `PARTIAL`.
- Only bounded rework for named QA findings is allowed; revised SHA requires fresh full focused verification and independent re-QA.
- After QA PASS, run disposable local WordPress/browser validation using existing local scripts where available, then ordinary fast-forward-only promotion. No force push/reset/amend.

## Later increments
SSE/streaming seam; cards/chips and booking flow; session resume/persistence; mobile, screen-reader, and Lighthouse validation; live provider integration and deployment remain explicitly subsequent work.
