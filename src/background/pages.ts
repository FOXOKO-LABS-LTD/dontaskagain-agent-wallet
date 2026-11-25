// Tell open extension pages that the worker's state changed (they re-read what they show).
export function notifyPages(): void {
  try { chrome.runtime.sendMessage({ event: 'changed' })?.catch?.(() => {}); } catch { /* no pages */ }
}
