// Server-rendered, script-free HTML. Every dynamic value is escaped; CSP forbids scripts and any off-origin load.
import type { DemoTurn } from './flow.js';
import { CHIPS, DEMO_LABEL } from './fixture.js';

export const esc = (v: unknown): string => String(v).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const href = (q: string, sim = false) => `/?q=${encodeURIComponent(q)}${sim ? '&sim=1' : ''}`;
const chip = (q: string, label: string) => `<li><a class="chip" href="${esc(href(q))}">${esc(label)}</a></li>`;

const CSS = `*{box-sizing:border-box}body{font:16px/1.5 system-ui,sans-serif;margin:0;background:#f4f6f8;color:#1b1f24}
main{max-width:760px;margin:auto;padding:12px}a{color:#0b5cad}:focus-visible{outline:3px solid #0b5cad;outline-offset:2px}
.demo{background:#5a2d82;color:#fff;padding:8px 12px;text-align:center;font-weight:600}
section,article{background:#fff;border:1px solid #d3d9df;border-radius:10px;padding:12px 16px;margin:12px 0}
ul.chips{display:flex;flex-wrap:wrap;gap:8px;list-style:none;padding:0;margin:8px 0}
.chip,button{display:inline-block;min-height:44px;padding:10px 14px;border-radius:22px;border:1px solid #0b5cad;background:#eaf2fb;color:#0b3d73;font:inherit;text-decoration:none;cursor:pointer}
.src{min-height:32px;padding:2px 10px;border-radius:16px;font-size:14px;background:#eef0f2;border-color:#8a949e;color:#1b1f24}
.status{border-left:6px solid #2e7d32;padding:8px 12px;background:#edf7ee}.status.insufficient_evidence{border-color:#b26a00;background:#fff4e0}.status.degraded{border-color:#b00020;background:#fdecee}
form.ask{display:flex;gap:8px;flex-wrap:wrap}form.ask input[type=text]{flex:1 1 220px;min-height:44px;padding:8px 12px;font:inherit;border:1px solid #6b7580;border-radius:8px}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px}.cards article{margin:0}
.you{background:#e8eef6}label{display:block;margin:8px 0}input[type=checkbox]{width:24px;height:24px;vertical-align:middle}
@media(max-width:480px){main{padding:8px}section,article{padding:10px 12px}.chip,button{width:100%;text-align:center}}`;

export const page = (title: string, body: string, status = 200) => ({
  status,
  html: `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} — Pilgrim AI DEMO</title><style>${CSS}</style></head><body>
<div class="demo" role="note">${esc(DEMO_LABEL)}</div>
<main><a href="#chat" class="chip">Skip to chat</a><header><h1>Pilgrim AI — client demo</h1></header>${body}
<footer><p><small>Demo only: invented hotels and prices, no sign-in, no outbound messages, no charges. Nothing leaves this computer.</small></p></footer></main></body></html>`,
});

const welcome = (open: boolean) => `<section aria-labelledby="welcome"><details${open ? ' open' : ''}><summary><h2 id="welcome" style="display:inline">Welcome</h2></summary>
<p>Hi, I'm the Pilgrim assistant (demo). I help compare Umrah hotels and always show where an answer comes from.</p>
<ol><li>Tell me the city, group size and nights.</li><li>I answer only from the listed sources and cite them.</li><li>If I lack evidence I say so, and you can ask a human advisor.</li></ol></details></section>`;

const ask = (value: string) => `<form class="ask" method="get" action="/"><label for="q" style="margin:0;flex-basis:100%">Ask about hotels or policies</label>
<input id="q" name="q" type="text" maxlength="200" required autocomplete="off" value="${esc(value)}"><button type="submit">Send</button></form>
<h3>Try one</h3><ul class="chips" aria-label="Suggested questions">${CHIPS.map((c) => chip(c, c)).join('')}</ul>`;

export function renderHome(turn?: DemoTurn): { status: number; html: string } {
  if (!turn) return page('Welcome', `${welcome(true)}<section id="chat" aria-labelledby="chat-h"><h2 id="chat-h">Chat</h2>${ask('')}</section>`);
  const r = turn.result;
  const src = (id: string) => `<a class="chip src" href="#src-${esc(id)}">Source: ${esc(turn.evidence[id]?.source ?? id)} · ${esc(id)}</a>`;
  const note: Record<string, string> = {
    grounded: 'Grounded: every statement below cites a listed source.',
    insufficient_evidence: "I don't have evidence for that in the demo sources, so I won't guess. Try a hotel or policy question, or ask a human advisor.",
    degraded: 'Degraded mode: the answer service had a problem, so no answer is shown rather than an unverified one.',
  };
  const claims = r.claims.map((c) => `<li>${esc(c.text)} <span class="cites">${c.citations.map((x) => src(x.evidence_id)).join(' ')}</span></li>`).join('');
  const recs = r.recommendations.map((x) => `<article aria-labelledby="${esc(x.id)}"><h3 id="${esc(x.id)}">#${x.rank} ${esc(x.title)}</h3><p>${esc(x.rationale)}</p><p>${x.citations.map((c) => src(c.evidence_id)).join(' ')}</p>
<a class="chip" href="/handoff?rec=${esc(encodeURIComponent(x.id))}">Talk to an advisor (mock)</a></article>`).join('');
  const sources = Object.values(turn.evidence).map((e) => `<li id="src-${esc(e.id)}"><strong>${esc(e.id)}</strong> — ${esc(e.source)}: ${esc(e.text)}</li>`).join('');
  const body = `${welcome(false)}<section id="chat" aria-labelledby="chat-h"><h2 id="chat-h">Chat</h2>
<ol aria-live="polite" aria-label="Conversation" style="list-style:none;padding:0">
<li class="you" style="padding:8px 12px;border-radius:10px"><strong>You:</strong> ${esc(r.diagnostics.input_masked)}</li>
<li><strong>Assistant:</strong>
<p class="status ${esc(r.status)}" role="${r.status === 'degraded' ? 'alert' : 'status'}">${esc(note[r.status])}${r.diagnostics.codes.length ? ` <small>(diagnostic: ${esc(r.diagnostics.codes.join(', '))})</small>` : ''}</p>
${claims ? `<ul>${claims}</ul>` : ''}</li></ol>
${turn.chips.length ? `<h3>Follow-up</h3><ul class="chips" aria-label="Follow-up questions">${turn.chips.map((c) => chip(c.q, c.label)).join('')}</ul>` : ''}
${r.status !== 'grounded' ? `<p><a class="chip" href="/handoff">Talk to an advisor (mock)</a></p>` : ''}
${ask(r.diagnostics.input_masked)}</section>
${recs ? `<section aria-labelledby="rec-h"><h2 id="rec-h">Recommendations (advisory only)</h2><div class="cards">${recs}</div></section>` : ''}
${sources ? `<section aria-labelledby="src-h"><h2 id="src-h">Sources</h2><ul>${sources}</ul></section>` : ''}
<section aria-labelledby="ctl-h"><h2 id="ctl-h">Demo controls</h2><p><a class="chip" href="${esc(href(turn.message, true))}">Simulate answer-service outage</a></p>${turn.simulated ? '<p><small>Outage simulated for this turn.</small></p>' : ''}</section>`;
  return page('Chat', body);
}

export function renderHandoff(rec: string | null, outcome?: { ok: boolean; text: string }): { status: number; html: string } {
  const result = outcome ? `<p class="status ${outcome.ok ? 'grounded' : 'degraded'}" role="${outcome.ok ? 'status' : 'alert'}">${esc(outcome.text)}</p>` : '';
  return page('Advisor handoff', `<section aria-labelledby="h-h"><h2 id="h-h">Talk to an advisor (mock)</h2>
<p>This is a rehearsal: nothing is sent to anyone. We store only a consent flag and the recommendation reference, in memory, until you stop the demo. No name, phone or email is collected.</p>${result}
<form method="post" action="/handoff"><input type="hidden" name="rec" value="${esc(rec ?? '')}">
<label><input type="checkbox" name="consent" value="yes"> I agree to a mock advisor follow-up record being created</label>
<button type="submit">Request advisor (mock)</button></form><p><a href="/">Back to chat</a></p></section>`);
}
