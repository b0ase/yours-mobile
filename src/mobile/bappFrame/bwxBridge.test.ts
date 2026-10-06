import { describe, expect, test } from 'bun:test';
import type { AgentAccount, AgentLogEntry } from '../agents/agentAccounts';
import { answerBwx, handleBwx, isBwxOrigin, parseBwx, type BwxDeps } from './bwxBridge';

const agent = (id: string, o: Partial<AgentAccount> = {}): AgentAccount => ({
  identityAddress: id,
  labels: [],
  stopped: false,
  dailyCapUsd: null,
  createdAt: 0,
  ...o,
});

const setup = (agents: AgentAccount[], answer = true, allStopped = false) => {
  const store = new Map(agents.map((a) => [a.identityAddress, { ...a }]));
  const calls: string[] = [];
  const asked: string[] = [];
  let stopAll = allStopped;
  const log: AgentLogEntry[] = [
    { at: 2, action: 'buy', detail: 'b', usd: 1.5, txid: 't' },
    { at: 1, action: 'send', detail: 'a', usd: 2 },
  ];
  const deps: BwxDeps = {
    listAgents: () => [...store.values()],
    getAgent: (id) => store.get(id) ?? null,
    ghostColorOf: (id) => (store.has(id) ? '#FF0000' : null),
    accountInfo: (id) => ({ name: `Agent ${id}`, handle: `$${id}` }),
    currentId: () => 'a1',
    balanceUsd: (id) => (id === 'a1' ? 12.5 : null),
    getLog: () => log,
    spentToday: (l) => l.reduce((s, e) => s + e.usd, 0),
    allStopped: () => stopAll,
    setStopped: (id, s) => {
      calls.push(`stopped:${id}:${s}`);
      store.get(id)!.stopped = s;
    },
    setAllStopped: (on) => {
      calls.push(`all:${on}`);
      stopAll = on;
    },
    setCap: (id, usd) => calls.push(`cap:${id}:${usd}`),
    setLabels: (id, l) => calls.push(`labels:${id}:${l.join(',')}`),
    confirm: async (text) => {
      asked.push(text);
      return answer;
    },
    openAccount: (id, screen) => void calls.push(`open:${id}:${screen}`),
    createAgent: () => void calls.push('create'),
  };
  return { deps, calls, asked };
};

describe('origin', () => {
  test('only the bAgents origins, exactly', () => {
    expect(isBwxOrigin('https://agents.bwalletx.com')).toBe(true);
    expect(isBwxOrigin('https://bagents.vercel.app')).toBe(false); // claimable by anyone
    expect(isBwxOrigin('https://bitcoin-writer.com')).toBe(false); // on the bApps list, not bAgents
    expect(isBwxOrigin('https://agents.bwalletx.com.evil.com')).toBe(false);
    expect(isBwxOrigin('https://agents.bwalletx.com/')).toBe(false);
    expect(isBwxOrigin('http://agents.bwalletx.com')).toBe(false);
    expect(isBwxOrigin('null')).toBe(false);
    expect(isBwxOrigin(undefined)).toBe(false);
  });
});

describe('parseBwx', () => {
  test('accepts a well-formed call', () => {
    expect(parseBwx({ type: 'BWX', isInvocation: true, id: 1, call: 'agents.list' })).toEqual({
      id: 1,
      call: 'agents.list',
      args: {},
    });
  });
  test('rejects malformed', () => {
    for (const m of [
      null,
      'x',
      [],
      { type: 'CWI', isInvocation: true, id: 1, call: 'agents.list' },
      { type: 'BWX', isInvocation: false, id: 1, call: 'agents.list' },
      { type: 'BWX', isInvocation: true, call: 'agents.list' },
      { type: 'BWX', isInvocation: true, id: '', call: 'agents.list' },
      { type: 'BWX', isInvocation: true, id: NaN, call: 'agents.list' },
      { type: 'BWX', isInvocation: true, id: 'x'.repeat(200), call: 'agents.list' },
      { type: 'BWX', isInvocation: true, id: 1 },
      { type: 'BWX', isInvocation: true, id: 1, call: 'agents.list', args: [] },
      { type: 'BWX', isInvocation: true, id: 1, call: 'agents.list', args: null },
    ])
      expect(parseBwx(m)).toBeNull();
  });
});

describe('handleBwx', () => {
  test('list', async () => {
    const { deps } = setup([agent('a1', { dailyCapUsd: 5 }), agent('a2', { stopped: true })]);
    const r = (await handleBwx('agents.list', {}, deps)) as { agents: Record<string, unknown>[]; allStopped: boolean };
    expect(r.allStopped).toBe(false);
    expect(r.agents[0]).toMatchObject({ id: 'a1', name: 'Agent a1', balanceUsd: 12.5, spentTodayUsd: 3.5, isCurrent: true });
    expect(r.agents[1]).toMatchObject({ id: 'a2', stopped: true, balanceUsd: null, isCurrent: false });
  });

  test('log validates id and limit', async () => {
    const { deps } = setup([agent('a1')]);
    expect(await handleBwx('agents.log', { id: 'a1', limit: 1 }, deps)).toHaveLength(1);
    expect(await handleBwx('agents.log', { id: 'a1' }, deps)).toHaveLength(2);
    for (const limit of [0, 201, 1.5, '5']) await expect(handleBwx('agents.log', { id: 'a1', limit }, deps)).rejects.toThrow();
    await expect(handleBwx('agents.log', { id: 'nope' }, deps)).rejects.toThrow('Unknown agent account');
    await expect(handleBwx('agents.log', { id: 5 }, deps)).rejects.toThrow();
  });

  test('stop and stopAll need no confirm', async () => {
    const { deps, calls, asked } = setup([agent('a1')], false);
    await handleBwx('agents.stop', { id: 'a1' }, deps);
    await handleBwx('agents.stopAll', {}, deps);
    expect(calls).toEqual(['stopped:a1:true', 'all:true']);
    expect(asked).toHaveLength(0);
  });

  test('resume asks and respects no', async () => {
    const no = setup([agent('a1', { stopped: true })], false);
    await expect(handleBwx('agents.resume', { id: 'a1' }, no.deps)).rejects.toThrow('Cancelled');
    expect(no.asked).toHaveLength(1);
    expect(no.calls).toHaveLength(0);
    const yes = setup([agent('a1', { stopped: true })], true);
    await handleBwx('agents.resume', { id: 'a1' }, yes.deps);
    expect(yes.calls).toEqual(['stopped:a1:false']);
  });

  test('resumeAll asks and respects no', async () => {
    const no = setup([], false, true);
    await expect(handleBwx('agents.resumeAll', {}, no.deps)).rejects.toThrow('Cancelled');
    expect(no.calls).toHaveLength(0);
    const yes = setup([], true, true);
    await handleBwx('agents.resumeAll', {}, yes.deps);
    expect(yes.calls).toEqual(['all:false']);
  });

  test('setCap: lowering is free; raising or removing asks', async () => {
    const lower = setup([agent('a1', { dailyCapUsd: 10 })], false);
    await handleBwx('agents.setCap', { id: 'a1', usd: 5 }, lower.deps);
    expect(lower.asked).toHaveLength(0);
    expect(lower.calls).toEqual(['cap:a1:5']);

    const add = setup([agent('a1')], false); // no cap → a cap is tighter
    await handleBwx('agents.setCap', { id: 'a1', usd: 5 }, add.deps);
    expect(add.asked).toHaveLength(0);

    for (const usd of [20, null, 0]) {
      const s = setup([agent('a1', { dailyCapUsd: 10 })], false);
      await expect(handleBwx('agents.setCap', { id: 'a1', usd }, s.deps)).rejects.toThrow('Cancelled');
      expect(s.asked).toHaveLength(1);
      expect(s.calls).toHaveLength(0);
    }
    const yes = setup([agent('a1', { dailyCapUsd: 10 })], true);
    await handleBwx('agents.setCap', { id: 'a1', usd: 20 }, yes.deps);
    expect(yes.calls).toEqual(['cap:a1:20']);
  });

  test('setCap validates usd', async () => {
    const { deps } = setup([agent('a1')]);
    for (const usd of [-1, NaN, Infinity, '5', undefined, 1e9])
      await expect(handleBwx('agents.setCap', { id: 'a1', usd }, deps)).rejects.toThrow();
  });

  test('setLabels validates', async () => {
    const { deps, calls } = setup([agent('a1')]);
    await handleBwx('agents.setLabels', { id: 'a1', labels: ['x', 'y'] }, deps);
    expect(calls).toEqual(['labels:a1:x,y']);
    for (const labels of ['x', [1], ['x'.repeat(65)], Array(33).fill('a')])
      await expect(handleBwx('agents.setLabels', { id: 'a1', labels }, deps)).rejects.toThrow();
  });

  test('open and create hand off to the wallet', async () => {
    const { deps, calls } = setup([agent('a1')]);
    await handleBwx('agents.open', { id: 'a1', screen: 'fund' }, deps);
    await handleBwx('agents.create', {}, deps);
    expect(calls).toEqual(['open:a1:fund', 'create']);
    await expect(handleBwx('agents.open', { id: 'a1', screen: 'send' }, deps)).rejects.toThrow();
    await expect(handleBwx('agents.open', { id: 'zz' }, deps)).rejects.toThrow('Unknown agent account');
  });

  test('unknown call and id give error replies', async () => {
    const { deps } = setup([agent('a1')]);
    expect(await answerBwx({ id: 7, call: 'agents.fund', args: {} }, deps)).toMatchObject({
      type: 'BWX',
      isInvocation: false,
      id: 7,
      status: 'error',
    });
    expect(await answerBwx({ id: 'x', call: 'agents.stop', args: { id: 'nope' } }, deps)).toMatchObject({
      status: 'error',
      description: 'Unknown agent account',
    });
    expect(await answerBwx({ id: 'y', call: 'agents.stop', args: { id: 'a1' } }, deps)).toEqual({
      type: 'BWX',
      isInvocation: false,
      id: 'y',
      status: 'success',
      result: true,
    });
  });
});
