// Background tasks without «Uncaught (in promise)» (0.1.7): every listener / fire-and-forget job goes through bg().
// A locked wallet is a normal state for background work (alarms, WebSocket messages): LOCKED is logged at debug level.
export function isLocked(e: unknown): boolean { return /^LOCKED/.test(String((e as Error)?.message ?? e)); }

export function logBg(where: string, e: unknown): void {
  if (isLocked(e)) { console.debug(`[agent-wallet] ${where}: skipped, the wallet is locked`); return; }
  console.warn(`[agent-wallet] ${where}:`, (e as Error)?.message ?? e);
}

/** Run a background job; errors are logged with their place and never escape. */
export function bg(where: string, f: () => unknown): void {
  try {
    Promise.resolve(f()).catch((e) => logBg(where, e));
  } catch (e) { logBg(where, e); }
}

/** Last resort: anything that still rejects unhandled is logged once with a readable text instead of a bundle dump. */
export function installGlobalCatch(): void {
  const g = globalThis as any;
  if (g.__awCatch || typeof g.addEventListener !== 'function') return;
  g.__awCatch = true;
  g.addEventListener('unhandledrejection', (ev: any) => { logBg('unhandled', ev?.reason); ev?.preventDefault?.(); });
}
