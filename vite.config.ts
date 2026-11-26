import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';

// 0.3.13: pages that may hand the extension a chat-app consent code (externally_connectable). The public build: only
// the public Signer (public/manifest.json); our internal build adds a loopback Signer for tests.
const EXTRA_CONNECTABLE: string[] = [
];
const connectable = () => ({
  name: 'externally-connectable',
  closeBundle() {
    if (!EXTRA_CONNECTABLE.length) return;
    const f = resolve(__dirname, 'dist/manifest.json');
    const m = JSON.parse(readFileSync(f, 'utf8'));
    m.externally_connectable = { matches: [...new Set([...(m.externally_connectable?.matches ?? []), ...EXTRA_CONNECTABLE])] };
    writeFileSync(f, JSON.stringify(m, null, 2) + '\n');
  },
});

// MV3 build: three pages (popup, side panel, sign window) + the module service worker at a fixed name (background.js).
export default defineConfig({
  plugins: [react(), connectable()],
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'chrome116',
    sourcemap: false,
    modulePreload: false,
    rollupOptions: {
      input: {
        popup: resolve(__dirname, 'popup.html'),
        sign: resolve(__dirname, 'sign.html'),
        panel: resolve(__dirname, 'panel.html'),
        background: resolve(__dirname, 'src/background/index.ts'),
      },
      output: {
        entryFileNames: (c) => (c.name === 'background' ? 'background.js' : 'assets/[name]-[hash].js'),
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
});
