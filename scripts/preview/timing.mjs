// First-frame timing of the preview pages (mock chrome.*, instant answers) in headless Chromium over CDP.
// Usage: node scripts/preview/timing.mjs <chrome> <preview-dir> [runs]. Prints median ms from navigation to the first
// frame with the app's header (body[data-ff], set by mock.ts). Measures the page only (bundle, parse, React render).
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { join, extname } from 'node:path';
import WebSocket from 'ws';

const [CH, DIR, RUNS = '9'] = process.argv.slice(2);
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.woff': 'font/woff' };
const srv = createServer((q, r) => { const f = join(DIR, decodeURIComponent(new URL(q.url, 'http://x').pathname)); if (!existsSync(f)) { r.writeHead(404); return r.end(); } r.writeHead(200, { 'Content-Type': types[extname(f)] ?? 'application/octet-stream' }); r.end(readFileSync(f)); });
await new Promise((r) => srv.listen(9948, '127.0.0.1', r));
const pr = spawn(CH, ['--headless', '--no-sandbox', '--disable-gpu', '--remote-debugging-port=9949', '--window-size=360,600', 'about:blank'], { stdio: 'ignore' });
await new Promise((r) => setTimeout(r, 1500));
const targets = await (await fetch('http://127.0.0.1:9949/json')).json();
const ws = new WebSocket(targets.find((t) => t.type === 'page').webSocketDebuggerUrl);
await new Promise((r) => ws.on('open', r));
let id = 0; const wait = new Map();
ws.on('message', (m) => { const x = JSON.parse(m); if (x.id && wait.has(x.id)) { wait.get(x.id)(x.result); wait.delete(x.id); } });
const cdp = (method, params = {}) => new Promise((r) => { const i = ++id; wait.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
await cdp('Network.enable'); await cdp('Network.setCacheDisabled', { cacheDisabled: false });
const B = 'http://127.0.0.1:9948/scripts/preview';
const pages = { 'popup (main screen)': `${B}/popup.html#/`, 'popup (accounts)': `${B}/popup.html#/accounts`, 'sign window': `${B}/sign.html`, 'side panel': `${B}/panel.html#/` };
const out = {};
for (const [name, url] of Object.entries(pages)) {
  const xs = [];
  for (let i = 0; i < Number(RUNS); i++) {
    await cdp('Page.navigate', { url: 'about:blank' });
    await new Promise((r) => setTimeout(r, 100));
    await cdp('Page.navigate', { url });
    let v = null;
    for (let k = 0; k < 60 && !v; k++) { await new Promise((r) => setTimeout(r, 50)); v = (await cdp('Runtime.evaluate', { expression: 'document.body && document.body.dataset.ff', returnByValue: true }))?.result?.value; }
    if (v) xs.push(Number(v));
  }
  xs.sort((a, b) => a - b);
  out[name] = { median_ms: xs[Math.floor(xs.length / 2)], min_ms: xs[0], max_ms: xs.at(-1), runs: xs.length };
}
console.log(JSON.stringify(out, null, 1));
ws.close(); pr.kill(); srv.close();
