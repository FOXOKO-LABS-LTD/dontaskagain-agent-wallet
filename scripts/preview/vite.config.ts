// Screenshot harness build (not part of the extension): popup / panel / sign pages with a mocked chrome.*.
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
const root = resolve(__dirname, '../..');
export default defineConfig({
  root, plugins: [react()], base: './',
  build: { outDir: process.env.PREVIEW_OUT ?? resolve(root, 'node_modules/.preview'), emptyOutDir: true, target: 'chrome116', modulePreload: false,
    rollupOptions: { input: { popup: resolve(__dirname, 'popup.html'), panel: resolve(__dirname, 'panel.html'), sign: resolve(__dirname, 'sign.html') } } },
});
