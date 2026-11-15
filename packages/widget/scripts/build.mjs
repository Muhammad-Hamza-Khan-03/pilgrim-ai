// Deterministic local build: src entrypoints -> browser IIFEs + sha256 metadata. No network.
import { build as esbuild } from 'esbuild';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
const entries = { 'loader.js': ['src/index.ts', undefined], 'chat.js': ['src/chat.ts', 'PilgrimChat'] };

export async function build(outDir) {
  mkdirSync(outDir, { recursive: true });
  const files = {};
  for (const [name, [entry, globalName]] of Object.entries(entries)) {
    await esbuild({
      entryPoints: [fileURLToPath(new URL(entry, root))],
      outfile: join(outDir, name),
      bundle: true, format: 'iife', globalName, target: 'es2019', platform: 'browser',
      minify: true, legalComments: 'none', logLevel: 'silent',
    });
    files[name] = createHash('sha256').update(readFileSync(join(outDir, name))).digest('hex');
  }
  const meta = { tool: 'esbuild', version: JSON.parse(readFileSync(new URL('../node_modules/esbuild/package.json', import.meta.url), 'utf8')).version, files };
  writeFileSync(join(outDir, 'build-meta.json'), JSON.stringify(meta, null, 2) + '\n');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await build(fileURLToPath(new URL('../../../wp-plugin/pilgrim-ai/assets/', import.meta.url)));
}
