// Bundles the local preview generator into one node script (workspace .ts deps inlined); no dev server, no network.
export default {
  build: { ssr: 'src/render-preview.ts', outDir: 'dist', emptyOutDir: true, target: 'node22' },
  ssr: { noExternal: true },
};
