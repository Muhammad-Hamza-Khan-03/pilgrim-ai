import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Strict scan: the local control-plane surface has no network, provider, credential, env, clock or storage access.
const dir = new URL('../src/', import.meta.url);
const files = readdirSync(dir).map((f) => [f, readFileSync(new URL(f, dir), 'utf8')] as const);
const FORBIDDEN: Array<[string, RegExp]> = [
  ['network', /\bfetch\s*\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon|node:(?:http|https|net|dgram|tls|dns|child_process)/],
  ['provider/sdk', /openai|anthropic|resend|sendgrid|twilio|stripe|posthog|segment|hubspot|salesforce|vercel|cloudflare|hono/i],
  ['credentials/env', /process\.env|import\.meta\.env|api[_-]?key|secret|password|bearer|authorization/i],
  ['production/storage writes', /localStorage|sessionStorage|indexedDB|document\.cookie|\bKV\b|\bD1\b|\.sqlite|production/],
  ['ambient clock/randomness', /Date\.now|new Date\(\)|Math\.random|performance\.now/],
];

describe('local-only isolation', () => {
  for (const [rule, re] of FORBIDDEN) {
    it(`no ${rule} in src`, () => {
      for (const [name, text] of files) expect({ name, hit: text.match(re)?.[0] }).toEqual({ name, hit: undefined });
    });
  }

  it('only file writes are the preview generator, to its own bundle directory', () => {
    const writers = files.filter(([, t]) => /node:fs|writeFile/.test(t)).map(([n]) => n);
    expect(writers).toEqual(['render-preview.ts']);
  });

  it('only imports workspace packages (no third-party runtime deps)', () => {
    for (const [name, text] of files) {
      for (const m of text.matchAll(/from '([^'.][^']*)'/g)) expect([name, m[1]]).toSatisfy(([, s]: string[]) => s!.startsWith('@pilgrim/') || s === 'node:fs');
    }
  });
});
