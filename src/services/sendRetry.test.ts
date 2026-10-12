import { describe, expect, it, mock } from 'bun:test';
import { createSendRetry, SEND_RETRY_ALARM, SEND_RETRY_PERIOD_MINUTES } from './sendRetry';

const setup = (queued: number[] | (() => Promise<{ queued: number; error?: string }>)) => {
  const alarms = { create: mock(), clear: mock(async () => true) };
  const sendWaiting = mock(async () => '');
  const list = Array.isArray(queued) ? [...queued] : [];
  const review = Array.isArray(queued) ? mock(async () => ({ queued: list.shift() ?? 0 })) : mock(queued);
  const r = createSendRetry({ sendWaiting, review, alarms, log: () => undefined });
  return { r, alarms, sendWaiting, review };
};

describe('sendRetry', () => {
  it('arms the alarm while sends are queued and clears it when none are', async () => {
    const { r, alarms, sendWaiting } = setup([2, 1, 0]);
    expect(await r.tick()).toBe(2);
    expect(alarms.create).toHaveBeenCalledWith(SEND_RETRY_ALARM, { periodInMinutes: SEND_RETRY_PERIOD_MINUTES });
    expect(r.armed()).toBe(true);
    await r.tick();
    expect(alarms.create).toHaveBeenCalledTimes(1); // not re-created (would reset the timer)
    expect(await r.tick()).toBe(0);
    expect(alarms.clear).toHaveBeenCalledWith(SEND_RETRY_ALARM);
    expect(r.armed()).toBe(false);
    expect(sendWaiting).toHaveBeenCalledTimes(3);
  });

  it('clears a leftover alarm when nothing is queued, even if never armed here', async () => {
    const { r, alarms } = setup([0]);
    await r.tick();
    expect(alarms.create).not.toHaveBeenCalled();
    expect(alarms.clear).toHaveBeenCalledTimes(1);
  });

  it('never runs twice at once: a tick during a run joins it', async () => {
    let release!: () => void;
    const { r, sendWaiting } = setup([1, 0]);
    sendWaiting.mockImplementationOnce(() => new Promise<string>((res) => (release = () => res(''))));
    const a = r.tick();
    const b = r.tick();
    expect(a).toBe(b);
    release();
    expect(await a).toBe(1);
    expect(sendWaiting).toHaveBeenCalledTimes(1);
    await r.tick(); // a new run after the first finished
    expect(sendWaiting).toHaveBeenCalledTimes(2);
  });

  it('keeps retrying when SendWaiting or the review fails', async () => {
    const { r, alarms, sendWaiting } = setup(async () => {
      throw new Error('db busy');
    });
    sendWaiting.mockRejectedValueOnce(new Error('timeout'));
    expect(await r.tick()).toBe(-1);
    expect(alarms.create).toHaveBeenCalledTimes(1);
    expect(alarms.clear).not.toHaveBeenCalled();
  });

  it('keeps retrying when the review reports an error', async () => {
    const { r, alarms } = setup(async () => ({ queued: 0, error: 'wallet closed' }));
    await r.tick();
    expect(r.armed()).toBe(true);
    expect(alarms.clear).not.toHaveBeenCalled();
  });

  it('arm is idempotent', () => {
    const { r, alarms } = setup([0]);
    r.arm();
    r.arm();
    expect(alarms.create).toHaveBeenCalledTimes(1);
  });
});
