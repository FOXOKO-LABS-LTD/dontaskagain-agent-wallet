// Minimal in-memory chrome.* for running the service worker in Node (flow test). Not a full emulation.
type Listener = (...a: any[]) => any;

function area() {
  let data: Record<string, any> = {};
  return {
    async get(keys?: string | string[] | null) {
      if (keys === null || keys === undefined) return structuredClone(data);
      const ks = Array.isArray(keys) ? keys : [keys];
      const out: Record<string, any> = {};
      for (const k of ks) if (k in data) out[k] = structuredClone(data[k]);
      return out;
    },
    async set(v: Record<string, any>) { for (const [k, x] of Object.entries(v)) { if (x === undefined) delete data[k]; else data[k] = structuredClone(x); } },
    async remove(keys: string | string[]) { for (const k of Array.isArray(keys) ? keys : [keys]) delete data[k]; },
    async clear() { data = {}; },
    _dump: () => data,
  };
}

export function installFakeChrome(extId = 'abcdefghijklmnopabcdefghijklmnop') {
  const onMessage: Listener[] = [];
  const windows: number[] = [];
  const notifications: any[] = [];
  const chrome: any = {
    storage: { local: area(), session: area() },
    runtime: {
      id: extId,
      getManifest: () => ({ version: '0.1.0' }),
      getURL: (p: string) => `chrome-extension://${extId}/${p}`,
      sendMessage: async (m: any) => { if (m?.event) throw new Error('no receivers'); return undefined; },
      onMessage: { addListener: (f: Listener) => onMessage.push(f), removeListener: () => {} },
      onInstalled: { addListener: () => {} },
      onStartup: { addListener: () => {} },
    },
    alarms: { create: async () => {}, onAlarm: { addListener: () => {} } },
    action: { setBadgeText: async () => {}, setBadgeBackgroundColor: async () => {} },
    notifications: { create: (...a: any[]) => notifications.push(a), onClicked: { addListener: () => {} } },
    windows: { create: async () => { windows.push(1); return { id: windows.length }; }, update: async () => ({}), onRemoved: { addListener: () => {} } },
    permissions: { request: async () => true },
  };
  (globalThis as any).chrome = chrome;
  // 0.3.2: a page signs only the build it shows — it sends that build's id. Like the real window, `call`
  // remembers the last view of each key and adds its build_id to a sign command that does not name one itself.
  const shown = new Map<string, string>();
  const SIGN_KEY: Record<string, string> = { sign: 'request_id', ownSign: 'own_id', evmSign: 'key', swapSign: 'swap_id' };
  const remember = (v: any) => { if (v && typeof v === 'object' && typeof v.key === 'string' && typeof v.build_id === 'string') shown.set(v.key, v.build_id); };
  /** Call the worker like a page does. */
  const call = <T = any>(msg: any): Promise<T> => new Promise((resolve, reject) => {
    const l = onMessage[0];
    if (!l) return reject(new Error('worker not loaded'));
    const k = SIGN_KEY[msg?.cmd];
    if (k && !('build_id' in msg)) msg = { ...msg, build_id: shown.get(msg[k]) };
    l(msg, { id: extId }, (r: any) => { if (r.ok) { remember(r.result); remember(r.result?.view); resolve(r.result); } else reject(new Error(r.error)); });
  });
  return { chrome, call, windows, notifications };
}
