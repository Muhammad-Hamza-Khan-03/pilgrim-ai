// Bundles the local demo server into one node script (workspace .ts deps inlined); no dev server, no network client.
export default {
  build: { ssr: 'src/server.ts', outDir: 'dist', emptyOutDir: true, target: 'node22' },
  ssr: { noExternal: true },
};
