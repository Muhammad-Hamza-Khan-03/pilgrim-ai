// Pure view -> static HTML. No script, no external resources, no forms: the preview is read-only by construction.
import type { ControlPlaneView, Section } from './index.js';

const esc = (v: unknown): string => String(v).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const badge = (state: string) => `<span class="badge ${esc(state)}">${esc(state)}</span>`;
const sec = <T,>(id: string, title: string, s: Section<T>, row: (t: T) => string) =>
  `<section id="${id}"><h2>${esc(title)} ${badge(s.state)}</h2><p class="msg">${esc(s.message)}</p>${s.items.length ? `<ul>${s.items.map((t) => `<li>${row(t)}</li>`).join('')}</ul>` : ''}</section>`;

export function renderPreviewHtml(v: ControlPlaneView): string {
  const w = v.widget;
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Pilgrim operator preview (local fixture)</title>
<style>body{font:15px system-ui;margin:0;background:#f6f7f9;color:#1b1f24}main{max-width:960px;margin:auto;padding:16px}
section,.card{background:#fff;border:1px solid #d8dde3;border-radius:8px;padding:12px 16px;margin:12px 0}
.rail{display:flex;gap:8px;list-style:none;padding:0;flex-wrap:wrap}.rail li{padding:6px 10px;border-radius:16px;background:#e8ebef}
.rail .done{background:#cdebd5}.rail .current{background:#ffe9a8;font-weight:600}
.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:8px}.kpis b{display:block;font-size:20px}
.badge{font-size:12px;padding:2px 8px;border-radius:10px;background:#e8ebef}.locked,.unavailable{background:#f8d4d0}.ready{background:#cdebd5}
.msg{color:#566}code{background:#eef;padding:1px 4px}button:disabled{opacity:.6}</style></head>
<body><main>
<h1>${esc(v.pack.name)} <small>(${esc(v.pack.id)})</small></h1>
<p class="msg">Local fixture preview. Read-only: nothing here contacts a network or changes data. Actions run through the typed control-plane seam and need explicit confirmation.</p>
<ol class="rail" aria-label="Setup progress">${v.rail.map((r) => `<li class="${r.status}">${esc(r.step)} (${r.status})</li>`).join('')}</ol>
<div class="kpis">${v.kpis.map((k) => `<div class="card">${esc(k.label)}<b>${esc(k.value)}</b></div>`).join('')}</div>
<section id="pack"><h2>Active pack</h2><p>Active version: <code>${esc(v.pack.activeVersion ?? 'none')}</code> &middot; Retrieval serves: <code>${esc(v.pack.retrievalVersion ?? 'nothing')}</code>${v.pack.disabled ? ' ' + badge('locked') : ''}</p></section>
${sec('sources', 'Source artifacts', v.sources, (s) => `${esc(s.filename ?? s.sourceId)} &middot; ${s.byteLength} B &middot; <code>${esc(s.sha256.slice(0, 12))}</code>`)}
${sec('staging', 'Staging diffs', v.staging, (s) => `<b>${esc(s.version)}</b> (parent ${esc(s.parentVersion ?? 'none')}, review ${esc(s.review)}): ${Object.entries(s.changes).map(([e, c]) => `${esc(e)} +${c.added}/-${c.removed}/~${c.changed}`).join(', ')}`)}
${sec('publications', 'Publication history', v.publications, (p) => `${esc(p.version)}${p.active ? ' (active)' : ''}`)}
${sec('rollback', 'Rollback candidates', v.rollbackCandidates, (r) => esc(r.version))}
${sec('failed', 'Failed ingestion jobs', v.failedJobs, (j) => `${esc(j.filename)}: <code>${esc(j.code)}</code> ${esc(j.message)}`)}
${sec('sessions', 'Session and grounding diagnostics', v.sessions, (s) => `${esc(s.sessionId)}: ${s.turns} turns, ${s.degraded} not fully grounded ${s.codes.map((c) => `<code>${esc(c)}</code>`).join(' ')}`)}
<section id="widget"><h2>Widget configuration ${badge(w.state)}</h2><p class="msg">${esc(w.message)}</p>${w.config ? `<pre>${esc(JSON.stringify(w.config, null, 2))}</pre>` : ''}</section>
<section id="actions"><h2>Actions (locked in this static preview)</h2><ul>${v.actions.map((a) => `<li><button disabled>${esc(a.action.type)}${'version' in a.action ? ' ' + esc(a.action.version) : ''}</button> confirm with <code>${esc(a.confirm)}</code>${a.lockedReason ? ` &middot; ${esc(a.lockedReason)}` : ''}</li>`).join('')}</ul></section>
<section id="audit"><h2>Audit log</h2>${v.audit.length ? `<ul>${v.audit.map((e) => `<li>#${e.seq} ${esc(e.action)}: ${esc(e.outcome)}${e.code ? ` (${esc(e.code)})` : ''}</li>`).join('')}</ul>` : '<p class="msg">No actions recorded.</p>'}</section>
</main></body></html>
`;
}
