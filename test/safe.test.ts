// Background jobs never leak «Uncaught (in promise)»: errors are logged with their place; LOCKED is not an error.
import { bg, isLocked } from '../src/background/safe';

describe('bg()', () => {
  it('async rejection → console.warn with the place; LOCKED → debug only; sync throw is caught too', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);
    bg('alarm', async () => { throw new Error('boom'); });
    bg('ws request.pay', async () => { throw new Error('LOCKED'); });
    bg('sync', () => { throw new Error('LOCKED: unlock to sign in'); });
    await new Promise((r) => setTimeout(r, 20));
    process.off('unhandledRejection', unhandled);
    expect(unhandled).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('alarm');
    expect(debug).toHaveBeenCalledTimes(2);
    expect(isLocked(new Error('LOCKED: x'))).toBe(true);
    warn.mockRestore(); debug.mockRestore();
  });
});
