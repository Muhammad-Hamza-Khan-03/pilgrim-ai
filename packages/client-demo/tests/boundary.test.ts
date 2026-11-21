import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Strict scan of the demo's own sources: no provider/network client/credential/CRM/WhatsApp/email/billing/auth.
const dir = new URL('../src/', import.meta.url);
const files = readdirSync(dir).map((f) => [f, readFileSync(new URL(f, dir), 'utf8')] as const);
const FORBIDDEN: Array<[string, RegExp]> = [
  ['network client', /\bfetch\s*\(|XMLHttpRequest|WebSocket|EventSource|sendBeacon|node:(?:https|net|dgram|tls|dns|child_process|http2)|\bhttps?\.request|\bget\(\s*['"]https?:/],
  ['provider/sdk', /openai|anthropic|gemini|llm|vercel|cloudflare|hono|express/i],
  ['crm/whatsapp/email/billing', /hubspot|salesforce|zoho|crm|whatsapp|twilio|sendgrid|resend|smtp|nodemailer|mailto:|stripe|billing|invoice|payment/i],
  ['auth/credentials/env', /process\.env|import\.meta\.env|api[_-]?key|secret|password|bearer|authorization|oauth|jwt|set-cookie|document\.cookie/i],
  ['browser storage/scripts', /localStorage|sessionStorage|indexedDB|<script|\beval\(|new Function/],
  ['ambient clock/randomness', /Date\.now|new Date\(\)|Math\.random|performance\.now/],
  ['file writes', /writeFile|appendFile|node:fs/],
];

describe('demo boundary scan', () => {
  for (const [rule, re] of FORBIDDEN) {
    it(`no ${rule}`, () => {
      for (const [name, text] of files) expect({ name, hit: text.match(re)?.[0] }).toEqual({ name, hit: undefined });
    });
  }
  it('only server.ts opens a socket, and only on loopback', () => {
    expect(files.filter(([, t]) => /node:http/.test(t)).map(([n]) => n)).toEqual(['server.ts']);
    const server = files.find(([n]) => n === 'server.ts')![1];
    expect(server).toContain("const host = '127.0.0.1'");
    expect(server).not.toMatch(/0\.0\.0\.0|::/);
  });
  it('imports only workspace packages, relative files, or node:http', () => {
    for (const [name, text] of files)
      for (const m of text.matchAll(/from '([^']+)'/g)) expect([name, m[1]]).toSatisfy(([, s]: string[]) => s!.startsWith('.') || s!.startsWith('@pilgrim/') || s === 'node:http');
  });
  it('page CSP blocks scripts and off-origin loads', async () => {
    const { createDemoApp } = await import('../src/app.js');
    const { html } = await createDemoApp()('GET', '/');
    expect(html).toContain("default-src 'none'; style-src 'unsafe-inline'; form-action 'self'");
    expect(html).not.toMatch(/(?:src|href|action)="https?:/);
  });
});
