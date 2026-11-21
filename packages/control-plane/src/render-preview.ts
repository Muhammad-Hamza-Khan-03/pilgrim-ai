// Writes dist/preview.html from the fixture. Local file output only.
import { writeFileSync } from 'node:fs';
import { createControlPlane } from './index.js';
import { renderPreviewHtml } from './render.js';

const out = new URL('./preview.html', import.meta.url);
writeFileSync(out, renderPreviewHtml(createControlPlane().snapshot()));
console.log(`wrote ${out.pathname}`);
