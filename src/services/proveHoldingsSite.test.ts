import { describe, expect, it, mock } from 'bun:test';
import { runSiteProveHoldings, type ProveHoldingsDeps } from './proveHoldingsSite';

const deps = (o: Partial<ProveHoldingsDeps> = {}): ProveHoldingsDeps => ({
  locked: async () => false,
  granted: async () => false,
  grant: mock(async () => undefined),
  ask: mock(async () => true),
  prove: mock(async () => 3),
  ...o,
});

describe('runSiteProveHoldings', () => {
  it('refuses other origins without asking', async () => {
    const d = deps();
    const r = await runSiteProveHoldings('https://evil.example', d);
    expect(r).toMatchObject({ success: false, code: 'ORIGIN' });
    expect(d.ask).not.toHaveBeenCalled();
    expect(d.prove).not.toHaveBeenCalled();
  });
  it('refuses a preview subdomain', async () => {
    expect(await runSiteProveHoldings('https://preview.bchatx.com', deps())).toMatchObject({ code: 'ORIGIN' });
  });
  it('asks once, remembers Allow, then proves', async () => {
    const d = deps();
    expect(await runSiteProveHoldings('https://www.bchatx.com', d)).toEqual({ success: true, data: { linked: 3 } });
    expect(d.ask).toHaveBeenCalledWith('www.bchatx.com');
    expect(d.grant).toHaveBeenCalledWith('https://www.bchatx.com');
  });
  it('skips the sheet once granted', async () => {
    const d = deps({ granted: async () => true });
    expect(await runSiteProveHoldings('https://bit-sign.online', d)).toMatchObject({ success: true });
    expect(d.ask).not.toHaveBeenCalled();
  });
  it('declined: nothing signed or stored', async () => {
    const d = deps({ ask: mock(async () => false) });
    expect(await runSiteProveHoldings('https://bchatx.com', d)).toMatchObject({ code: 'ERR_PERMISSION_DENIED' });
    expect(d.grant).not.toHaveBeenCalled();
    expect(d.prove).not.toHaveBeenCalled();
  });
  it('locked: refused without a sheet', async () => {
    const d = deps({ locked: async () => true });
    expect(await runSiteProveHoldings('https://bchatx.com', d)).toMatchObject({ code: 'LOCKED' });
    expect(d.ask).not.toHaveBeenCalled();
  });
  it('a failed proof is an error, not a throw', async () => {
    const d = deps({ granted: async () => true, prove: async () => Promise.reject(new Error('needs handle')) });
    expect(await runSiteProveHoldings('https://bchatx.com', d)).toMatchObject({ code: 'ERROR', error: 'needs handle' });
  });
});
