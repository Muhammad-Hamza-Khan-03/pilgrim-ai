// Deterministic static verification; needs only Node (no php/WordPress). Run: node wp-plugin/tests/verify.mjs
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';

const dir = new URL('../pilgrim-ai/', import.meta.url);
const src = readFileSync(new URL('pilgrim-ai.php', dir), 'utf8');
const widget = readFileSync(new URL('../../packages/widget/src/index.ts', import.meta.url), 'utf8');
const has = (re, msg) => assert.match(src, re, msg);
const hasNot = (re, msg) => assert.doesNotMatch(src, re, msg);

// 1. Plugin header (what the WP scanner reads)
has(/^<\?php\s*\/\*\*[\s\S]*?\* Plugin Name: Pilgrim AI Widget/, 'plugin header');
has(/\* Version: \d+\.\d+\.\d+/, 'version');
has(/defined\( 'ABSPATH' \) \|\| exit;/, 'ABSPATH guard');
assert.ok(existsSync(new URL('uninstall.php', dir)), 'uninstall.php');

// 2. Loader contract parity: tenant regex and data-* attribute names match the widget
assert.ok(widget.includes('/^[A-Za-z0-9_-]+$/'), 'widget tenant rule changed');
has(/\^\[A-Za-z0-9_-\]\+\\z/, 'tenant regex parity');
for (const a of ['data-tenant', 'data-bundle-url', 'data-api-url']) {
  assert.ok(widget.includes(`'${a}'`), `widget reads ${a}`);
  has(new RegExp(a), `plugin emits ${a}`);
}
has(/src="%s" defer data-tenant/, 'loader_url emitted as src');
hasNot(/data-loader-url/, 'loader_url must not be a data attribute');

// 3. Escaping / fail closed
has(/esc_url\( \$loader \)/, 'src escaped');
has(/esc_attr\( \$tenant \)/, 'tenant escaped');
has(/esc_url\( \$bundle \)/, 'bundle escaped');
has(/esc_url\( \$api \)/, 'api escaped');
has(/\[ 'http', 'https' \]|array\( 'http', 'https' \)/, 'http(s) allowlist');
has(/'' === \$loader \|\| '' === \$tenant \|\| '' === \$bundle\s*\)\s*\{\s*return '';/, 'fail closed on missing required');
hasNot(/\$_(GET|POST|REQUEST)/, 'no direct superglobal input');
hasNot(/wp_remote_|curl_|file_get_contents|wp_insert_|\$wpdb/, 'no network/db');

// 4. Settings API, capability, duplicate prevention, hook scope
has(/register_setting\(/, 'register_setting');
has(/settings_fields\( 'pilgrim_ai' \)/, 'nonce via settings_fields');
has(/'manage_options'[\s\S]*current_user_can\( 'manage_options' \)/, 'capability on menu and page');
has(/static \$printed = false/, 'duplicate guard');
has(/is_admin\(\) \|\| is_feed\(\)/, 'front-end only');
assert.equal((src.match(/add_action\( 'wp_footer'/g) ?? []).length, 1, 'single footer hook');

// 5. Behavioural mirror of the PHP validators (same rules) to pin the fail-closed cases
const url = (r) => {
  if (typeof r !== 'string') return '';
  r = r.trim();
  if (!r || /[\s<>"'\\]/.test(r)) return '';
  try { const u = new URL(r); return (u.protocol === 'http:' || u.protocol === 'https:') && u.host ? r : ''; } catch { return ''; }
};
const tenant = (r) => (/^[A-Za-z0-9_-]+$/.test(typeof r === 'string' ? r.trim() : '') ? r.trim() : '');
for (const bad of ['javascript:alert(1)', 'data:text/html,x', '//x.com/a.js', 'https://a.com/"onload=x', 'ftp://a.com/x', '', null])
  assert.equal(url(bad), '', `rejects ${bad}`);
assert.equal(url('https://cdn.example.com/loader.js'), 'https://cdn.example.com/loader.js');
for (const bad of ['a b', 'a"><script>', '', 'a/b']) assert.equal(tenant(bad), '', `rejects tenant ${bad}`);
assert.equal(tenant('acme_1-x'), 'acme_1-x');

// 5b. Local bundled assets: explicit opt-in, files must exist, committed artifacts match metadata
import { createHash } from 'node:crypto';
has(/function pilgrim_ai_local_settings\(/, 'local assets helper');
has(/'1' !== \( \$s\['local_assets'\] \?\? '' \)/, 'local assets is explicit opt-in');
has(/is_readable\( \$dir \. 'loader\.js' \) && is_readable\( \$dir \. 'chat\.js' \)/, 'missing local files fail closed');
has(/'local_assets' => '1' === /, 'local_assets sanitized to 0/1 flag');
const assets = new URL('assets/', dir);
const meta = JSON.parse(readFileSync(new URL('build-meta.json', assets), 'utf8'));
for (const [f, h] of Object.entries(meta.files))
  assert.equal(createHash('sha256').update(readFileSync(new URL(f, assets))).digest('hex'), h, `${f} matches build-meta`);

// 6. Optional real syntax check when php exists
try { execFileSync('php', ['-l', new URL('pilgrim-ai.php', dir).pathname], { stdio: 'pipe' }); console.log('php -l: ok'); }
catch (e) { console.log(e.code === 'ENOENT' ? 'php -l: SKIPPED (php not installed)' : (() => { throw e; })()); }

console.log('wp-plugin verify: ok');
