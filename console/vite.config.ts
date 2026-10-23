import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

// Dev: `npm run dev:console` proxies the API to a hub (wrangler dev on 8787, or set HUB_URL).
const hub = process.env.HUB_URL || 'http://127.0.0.1:8787';

// Each build has an id, also written to version.json: an open console notices a newer deploy.
const BUILD_ID = Date.now().toString(36);
const version = { name: 'build-version', generateBundle() { this.emitFile({ type: 'asset', fileName: 'version.json', source: JSON.stringify({ build: BUILD_ID }) }); } };

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [react(), version],
  define: { __BUILD_ID__: JSON.stringify(BUILD_ID) },
  build: { outDir: 'dist', emptyOutDir: true },
  server: {
    proxy: { '/admin': hub, '/api': hub, '/health': hub },
  },
});
