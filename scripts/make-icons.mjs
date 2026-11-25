// Extension icons from the UI kit (0.3.6): logo/icon-<16|32|48|128>[-badge-safe|-locked].png → public/icons/icon<N>[…].png.
// The manifest uses the plain ones for the extension (0.3.7: icon128 is then refitted by make-action-icons.py) and
// scripts/make-action-icons.py makes the toolbar ones (action-*.png); the badge-safe ones stay unused (the worker draws the
// counter of waiting requests there). The grey -locked ones are kept for a later «locked» toolbar state; unused today.
// Usage: node scripts/make-icons.mjs <ui-kit-dir>
import { copyFileSync, mkdirSync } from 'node:fs';
const kit = process.argv[2]?.replace(/\/$/, '');
if (!kit) { console.error('usage: node scripts/make-icons.mjs <ui-kit-dir>'); process.exit(1); }
mkdirSync('public/icons', { recursive: true });
for (const s of [16, 32, 48, 128]) for (const v of ['', '-badge-safe', '-locked']) copyFileSync(`${kit}/logo/icon-${s}${v}.png`, `public/icons/icon${s}${v}.png`);
console.log('icons copied');
