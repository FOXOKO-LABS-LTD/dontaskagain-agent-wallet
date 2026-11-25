// Tests run in Russian unless a test switches the language itself (the default of a real browser follows its UI
// language; Node says en-US). test/i18n.test.ts covers English and the detection.
Object.defineProperty(globalThis.navigator, 'language', { value: 'ru-RU', configurable: true });

// 0.3.2: tests never reach the network — only the in-process mock on 127.0.0.1 (live tests opt in with AW_LIVE_*).
if (!process.env.AW_LIVE_NODE && !process.env.AW_LIVE_EVM) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = ((u: any, o?: any) => {
    const url = new URL(typeof u === 'string' ? u : u?.url ?? String(u));
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) return Promise.reject(new TypeError(`test: no network (${url.origin})`));
    return realFetch(u, o);
  }) as typeof fetch;
}
