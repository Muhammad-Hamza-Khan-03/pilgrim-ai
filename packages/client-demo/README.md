# @pilgrim/client-demo

Local, fixture-backed **DEMO** of the visitor experience. Invented hotels and prices; separate from all production packages (nothing else imports it).

```sh
pnpm install --frozen-lockfile
pnpm --filter @pilgrim/client-demo demo          # builds, serves http://127.0.0.1:8788/
node packages/client-demo/dist/server.js 9000    # custom port (after a build)
pnpm --filter @pilgrim/client-demo test          # flow + boundary scan
pnpm --filter @pilgrim/client-demo typecheck
```

Walkthrough: welcome/onboarding → ask (try the suggested chips) → grounded answer with source chips → advisory recommendation cards → follow-up chips → "Do you fly to Mars?" (insufficient evidence) → "Simulate answer-service outage" (degraded) → "Talk to an advisor (mock)" consent form.

What is real: `runGroundedTurn`, `recommend`, `selectFollowUp` (engine), tenant context (identity), lead/handoff lifecycle (leads-analytics, in memory). What is fake: the catalog, a rule-based composer standing in for a model, and the advisor handoff (nothing is sent; no contact data is collected).

Boundaries (enforced by `tests/boundary.test.ts`): no network client, provider, credential/env, CRM, WhatsApp, email, billing or auth code; no scripts or off-origin loads (CSP); server binds `127.0.0.1` only and rejects other Host headers. Pages are script-free server-rendered HTML (landmarks, labels, live regions, 44px targets, mobile layout).
