# Phase 4B Task Contract — WordPress plugin seam

## Objective
Add the smallest local, provider-neutral WordPress PHP plugin seam that safely installs and loads the existing `@pilgrim/widget` lazy loader. The plugin must emit one configured loader script on eligible WordPress front-end requests, preserve the loader's lazy-load behavior, and fail closed when configuration is incomplete or unsafe.

## Boundary
- In scope: a self-contained installable plugin under `wp-plugin/`; minimal settings registration/page for loader URL, tenant, optional API URL, and chat bundle URL; safe front-end script emission; focused local tests or static/runtime verification; documentation of local installation and mobile-oriented validation limits.
- Contract clarification: `loader_url` is a required setting for the emitted script's `src`. `data-bundle-url` is the existing loader's first-activation chat-bundle URL, not the loader script itself; the repository has no built `loader.js` artifact. This explicit setting avoids guessing a hosting/layout relationship and does not add a provider or deployment.
- The plugin may use WordPress hooks/options/escaping APIs and must not require a provider, cloud service, live API, persistence beyond WordPress options, or a running WordPress site to load the widget seam.
- Existing widget behavior remains authoritative: launcher only at initial load; chat bundle is loaded on first activation; invalid config fails closed; no provider/network calls are introduced by the loader or plugin.
- Chat bundle integration in this increment is a documented seam: the plugin passes the configured bundle URL to the existing loader. No new Preact chat UI, SSE client, card/chip/book flow, or provider implementation is in scope unless already present.

## Acceptance criteria
1. A standard WordPress plugin scanner can identify the plugin from a valid plugin header, and activation does not require provider credentials or network access.
2. Front-end output contains at most one async/deferred loader script and only when tenant and bundle URL are valid; API URL is optional and validated when supplied.
3. All emitted attribute values are escaped; unsafe schemes/tenant values fail closed; no raw user HTML is emitted.
4. Admin settings are capability- and nonce-protected, use the WordPress Settings API, and retain only the bounded configuration needed by the loader.
5. Existing widget loader tests remain green, and plugin-specific verification demonstrates installation metadata, safe configuration emission, duplicate prevention, and fail-closed behavior without live WordPress/provider dependencies.
6. LocalWP/mobile-oriented validation is recorded as a reproducible checklist and clearly distinguishes executable local/static evidence from unavailable GUI/device evidence; no Phase 5 public demo proof is claimed.
7. No cloud/provider calls, persistence/database schema, deployment, publishing, production activation, force-push, reset, amend, or unrelated repository changes.

## Implementation owner/tool
- Implementation owner: delegated Claude Code implementation worker, constrained to this worktree and this contract.
- Manager owns contract, commit packaging, independent QA, bounded rework, staging acceptance, and normal fast-forward promotion.

## QA handoff
Independent `qa-engineer` verification must run read-only against the exact immutable candidate SHA, checking parent/base, changed-file manifest, attribution, clean status, plugin syntax/static behavior, widget tests/typecheck, security/fail-closed cases, and exclusions. QA must end with `QA VERDICT: PASS|FAIL|PARTIAL`. Any FAIL permits only bounded rework against the named finding, followed by fresh verification and re-QA of the revised SHA.

## Exclusions
- Phase 5 public demo/install/video proof.
- Cloudflare Pages, hosted assets, live API/provider/LLM, credentials, deployment, publishing, production, real LocalWP site, real mobile device, Lighthouse upload, accessibility certification, or persistence beyond WordPress option storage.
- New chat product behavior beyond the existing loader integration seam.
- Changes outside Pilgrim AI or unrelated worktrees/repositories.
