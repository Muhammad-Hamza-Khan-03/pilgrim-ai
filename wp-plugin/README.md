# Pilgrim AI WordPress plugin (Phase 4B seam)

Emits one deferred `<script>` on front-end pages for the existing `@pilgrim/widget` lazy loader:

```html
<script src="{loader_url}" defer data-tenant="{tenant}" data-bundle-url="{bundle_url}" data-api-url="{api_url?}"></script>
```

- `loader_url` (required): URL of the loader script itself. **No built `loader.js` exists in this repo yet**; you must host a build yourself.
- `bundle_url` (required): the chat bundle the loader fetches on first click (not the loader).
- `tenant` (required, `[A-Za-z0-9_-]+`), `api_url` (optional). URLs must be http(s).
- Missing/invalid required value → nothing is emitted. Output is skipped in admin/feeds and printed at most once per request.
- Settings: Settings → Pilgrim AI (Settings API; `manage_options` + core nonce). Stored only in option `pilgrim_ai_settings`; removed on uninstall.

## Install
Zip the `wp-plugin/pilgrim-ai/` folder and upload via Plugins → Add New → Upload, or copy it to `wp-content/plugins/`.

## Verification
| Evidence | Status | How |
|---|---|---|
| Plugin header, escaping, capability/nonce wiring, duplicate guard, loader attribute parity, validator cases | Executable (static + JS mirror of PHP rules) | `node wp-plugin/tests/verify.mjs` |
| PHP syntax | Runs only if `php` is installed (else reported SKIPPED) | same command / `php -l wp-plugin/pilgrim-ai/pilgrim-ai.php` |
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

## Local host fixture (Phase 2, static)
`wp-plugin/fixtures/host.html` is a static page showing the loader tag with the optional host attributes (`data-site-id`, `data-version`, `data-allowed-origins`). It needs no WordPress and no network; the PHP plugin does not emit these attributes yet. Behavior is covered by `pnpm --filter @pilgrim/widget test` (no built widget artifact is committed; there is no build script).
