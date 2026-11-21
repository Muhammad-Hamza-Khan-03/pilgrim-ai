// Pure request handler (no sockets) so tests drive the exact demo behaviour.
import { createDemoHandoff, runDemoTurn } from './flow.js';
import { page, renderHandoff, renderHome } from './render.js';

const REC = /^rec_[0-9a-f]{8}$/;
const MAX_Q = 200;

export function createDemoApp() {
  const handoff = createDemoHandoff();
  return async (method: string, url: string, body = ''): Promise<{ status: number; html: string }> => {
    const u = new URL(url, 'http://demo.local');
    if (u.pathname === '/' && method === 'GET') {
      const q = (u.searchParams.get('q') ?? '').trim().slice(0, MAX_Q);
      return renderHome(q ? await runDemoTurn(q, { simulateProviderFailure: u.searchParams.get('sim') === '1' }) : undefined);
    }
    if (u.pathname === '/handoff') {
      if (method === 'GET') { const r = u.searchParams.get('rec'); return renderHandoff(r && REC.test(r) ? r : null); }
      if (method === 'POST') {
        const f = new URLSearchParams(body.slice(0, 2048));
        const r = f.get('rec');
        const rec = r && REC.test(r) ? r : null;
        const res = handoff.submit(f.get('consent') === 'yes', rec);
        return res.ok ? renderHandoff(rec, { ok: true, text: `Mock handoff ${res.handoff}, follow-up ${res.followUp}. Nothing was sent anywhere.` })
          : renderHandoff(rec, { ok: false, text: res.code === 'consent_required' ? 'Please tick the consent box first; nothing was recorded.' : `Could not record the request (${res.code}).` });
      }
    }
    return page('Not found', '<p>Not found. <a href="/">Back to the demo</a></p>', 404);
  };
}
