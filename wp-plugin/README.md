# Pilgrim AI WordPress plugin (Phase 4B seam)

Emits one deferred `<script>` on front-end pages for the existing `@pilgrim/widget` lazy loader:

```html
<script src="{loader_url}" defer data-tenant="{tenant}" data-bundle-url="{bundle_url}" data-api-url="{api_url?}"></script>
```

- `loader_url` (required unless local assets are enabled): URL of the loader script itself.
- **Local assets (opt-in)**: tick "Use bundled local assets" to serve the committed `pilgrim-ai/assets/loader.js` and `chat.js` from the plugin directory; Loader/Bundle URLs are then ignored. If either file is missing/unreadable nothing is emitted (fail closed). The loader makes no network request itself; the chat bundle is fetched only on first launcher click, and `chat.js` exposes `PilgrimChat.createChatClient` which only uses a caller-injected `fetch`.
- `bundle_url` (required): the chat bundle the loader fetches on first click (not the loader).
- `tenant` (required, `[A-Za-z0-9_-]+`), `api_url` (optional). URLs must be http(s).
- Missing/invalid required value → nothing is emitted. Output is skipped in admin/feeds and printed at most once per request.
- Settings: Settings → Pilgrim AI (Settings API; `manage_options` + core nonce). Stored only in option `pilgrim_ai_settings`; removed on uninstall.

## Rebuilding the bundle
`pnpm --filter @pilgrim/widget build` regenerates `pilgrim-ai/assets/{loader.js,chat.js,build-meta.json}` (esbuild, IIFE, minified, sha256 in `build-meta.json`). Tests fail if the committed files differ from a fresh build, so commit them together with any `packages/widget/src` change.

## Install
Zip the `wp-plugin/pilgrim-ai/` folder and upload via Plugins → Add New → Upload, or copy it to `wp-content/plugins/`.

## Verification
| Evidence | Status | How |
|---|---|---|
| Plugin header, escaping, capability/nonce wiring, duplicate guard, loader attribute parity, validator cases | Executable (static + JS mirror of PHP rules) | `node wp-plugin/tests/verify.mjs` |
| PHP syntax | Runs only if `php` is installed (else reported SKIPPED) | same command / `php -l wp-plugin/pilgrim-ai/pilgrim-ai.php` |
| Bundle reproducibility, IIFE shape, no implicit network, loader a11y/keyboard/fail-closed | Executable | `pnpm --filter @pilgrim/widget test` (`tests/bundle.test.ts`) |
| Widget loader behavior | Executable | `pnpm --filter @pilgrim/widget test && pnpm --filter @pilgrim/widget typecheck` |
| PHP runtime behavior inside WordPress | **Unavailable** (no PHP/WP here) | LocalWP checklist below |
| LocalWP GUI, real mobile device, Lighthouse, a11y certification | **Unavailable / not performed** | checklist below |

## LocalWP + mobile checklist (to be performed by a human; not yet done)
- [ ] Create a LocalWP site; install and activate the plugin (no provider credentials needed).
- [ ] Settings → Pilgrim AI: save with valid values; confirm invalid values (`javascript:…`, tenant `a b`) are rejected with a notice.
- [ ] As a non-admin (e.g. Editor), confirm the settings page and `options.php` save are denied.
- [ ] View page source on a front-end page: exactly one `<script … data-tenant …>`; none when a required field is blank; none in wp-admin.
- [ ] Network tab: only the loader loads initially; the chat bundle requests only after tapping the launcher.
- [ ] On a real phone (LAN URL to the LocalWP site): launcher visible, tappable, no layout overlap.
