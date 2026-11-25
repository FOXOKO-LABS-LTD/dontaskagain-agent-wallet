// Side panel (like TronLink): «open in the side panel» and «always open in the side panel».
// An open panel keeps a port named "panel"; while one is open, agent requests are shown in it instead of a window.
const ports = new Set<chrome.runtime.Port>();

export function initPanelPorts(onChange: () => void): void {
  chrome.runtime.onConnect?.addListener((port) => {
    if (port.name !== 'panel' || port.sender?.id !== chrome.runtime.id) return;
    ports.add(port);
    port.onDisconnect.addListener(() => { ports.delete(port); onChange(); });
    onChange();
  });
}

export const panelOpen = (): boolean => ports.size > 0;

/** Tell open panels to show the request queue. Returns false when no panel is open. */
export function showRequestsInPanel(): boolean {
  if (!ports.size) return false;
  for (const p of ports) { try { p.postMessage({ event: 'requests' }); } catch { ports.delete(p); } }
  return ports.size > 0;
}

/** The toolbar icon: popup (default) or the side panel. The popup must be unset for openPanelOnActionClick to work. */
export async function applyPanelBehavior(always: boolean): Promise<void> {
  try {
    await chrome.sidePanel?.setPanelBehavior({ openPanelOnActionClick: always });
    await chrome.action.setPopup?.({ popup: always ? '' : 'popup.html' });
  } catch (e) { console.warn('side panel', e); }
}
