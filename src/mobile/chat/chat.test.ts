import { describe, expect, test } from 'bun:test';
import { BchatClient, ChatApiError, needsHandle, type Http } from './api';
import {
  filterRooms,
  isBotMessage,
  isEphemeral,
  settleEphemeral,
  latestCursor,
  mergeMessages,
  oldestCursor,
  previewText,
  roomTitle,
  sortRooms,
  threadItems,
  type ChatMessage,
  type ChatRoom,
} from './messages';

const msg = (id: string, at: string, extra: Partial<ChatMessage> = {}): ChatMessage => ({
  id,
  author_handle: 'alice',
  kind: 'text',
  body: id,
  created_at: at,
  ...extra,
});

describe('mergeMessages', () => {
  test('dedupes by id and keeps oldest-first order', () => {
    const a = msg('a', '2026-10-01T10:00:00Z');
    const b = msg('b', '2026-10-01T10:01:00Z');
    const c = msg('c', '2026-10-01T10:02:00Z');
    const out = mergeMessages([c, a], [b, a]);
    expect(out.map((m) => m.id)).toEqual(['a', 'b', 'c']);
  });

  test('server row replaces the optimistic copy once', () => {
    const pending = msg('tmp', '2026-10-01T10:05:00Z', {
      pending: true,
      localId: 'l1',
      body: 'hi',
      author_handle: 'me',
    });
    const pending2 = msg('tmp2', '2026-10-01T10:05:01Z', {
      pending: true,
      localId: 'l2',
      body: 'hi',
      author_handle: 'me',
    });
    const server = msg('s1', '2026-10-01T10:05:00Z', { body: 'hi', author_handle: 'me' });
    let out = mergeMessages([pending, pending2], [server]);
    expect(out.map((m) => m.id)).toEqual(['s1', 'tmp2']);
    // Re-polling the same server row must not consume the second pending "hi".
    out = mergeMessages(out, [server]);
    expect(out.map((m) => m.id)).toEqual(['s1', 'tmp2']);
  });

  test('edited version replaces the superseded row in its original position', () => {
    const a = msg('a', '2026-10-01T10:00:00Z');
    const b = msg('b', '2026-10-01T10:01:00Z');
    const a2 = msg('a2', '2026-10-01T11:00:00Z', { supersedes_id: 'a', root_id: 'a', body: 'edited' });
    const out = mergeMessages([a, b], [a2]);
    expect(out.map((m) => m.id)).toEqual(['a2', 'b']);
  });

  test('prepending an older page works', () => {
    const newer = [msg('c', '2026-10-01T10:02:00Z')];
    const older = [msg('a', '2026-09-30T10:00:00Z'), msg('b', '2026-09-30T10:01:00Z')];
    expect(mergeMessages(newer, older).map((m) => m.id)).toEqual(['a', 'b', 'c']);
  });

  test('cursors ignore pending messages', () => {
    const list = [
      msg('a', '2026-10-01T10:00:00Z'),
      msg('b', '2026-10-01T10:01:00Z'),
      msg('p', '2026-10-01T10:09:00Z', { pending: true }),
    ];
    expect(latestCursor(list)).toBe('2026-10-01T10:01:00Z');
    expect(oldestCursor(list)).toBe('2026-10-01T10:00:00Z');
  });
});

describe('threadItems', () => {
  test('inserts day separators and marks my bubbles', () => {
    const now = new Date('2026-10-01T12:00:00');
    const items = threadItems(
      [
        msg('a', new Date('2026-09-30T09:00:00').toISOString()),
        msg('b', new Date('2026-10-01T09:00:00').toISOString(), { author_handle: '$Me' }),
        msg('c', new Date('2026-10-01T09:01:00').toISOString(), { author_handle: 'me' }),
      ],
      'me',
      now,
    );
    expect(items.map((i) => i.type)).toEqual(['day', 'msg', 'day', 'msg', 'msg']);
    expect(items[0].type === 'day' && items[0].label).toBe('Yesterday');
    expect(items[2].type === 'day' && items[2].label).toBe('Today');
    const [b, c] = [items[3], items[4]];
    expect(b.type === 'msg' && b.mine && b.firstOfGroup).toBe(true);
    expect(c.type === 'msg' && c.mine && !c.firstOfGroup).toBe(true);
  });
});

describe('rooms', () => {
  const rooms: ChatRoom[] = [
    {
      id: '1',
      ticker: 'DM1',
      name: '$me ↔ $bob',
      last_message: {
        author_handle: 'me',
        kind: 'text',
        body: 'yo',
        event_type: null,
        created_at: '2026-10-01T09:00:00Z',
      },
    },
    { id: '2', ticker: 'NPG', name: 'Ninja Punk Girls', updated_at: '2026-10-01T11:00:00Z' },
  ];
  test('DM title is the other party', () => {
    expect(roomTitle(rooms[0], 'me')).toBe('$bob');
    expect(roomTitle({ name: '$bob ↔ $me', ticker: 'X' }, '$ME')).toBe('$bob');
    expect(roomTitle({ name: null, ticker: 'NPG' }, 'me')).toBe('$NPG');
  });
  test('preview, sort and search', () => {
    expect(previewText(rooms[0], 'me')).toBe('You: yo');
    expect(previewText(rooms[1], 'me')).toBe('No messages yet');
    expect(sortRooms(rooms).map((r) => r.id)).toEqual(['2', '1']);
    expect(filterRooms(rooms, '$bo', 'me').map((r) => r.id)).toEqual(['1']);
    expect(filterRooms(rooms, 'ninja', 'me').map((r) => r.id)).toEqual(['2']);
  });
});

type Call = { method: string; url: string; headers: Record<string, string>; body?: unknown };
const fakeHttp = (routes: Record<string, (c: Call) => { status: number; data: unknown }>) => {
  const calls: Call[] = [];
  const http: Http = async (req) => {
    calls.push(req);
    const path = new URL(req.url).pathname;
    const handler = routes[`${req.method} ${path}`];
    return handler ? handler(req) : { status: 404, data: { error: 'nope' } };
  };
  return { http, calls };
};

describe('BchatClient', () => {
  test('signIn: challenge → sign → verify, then bearer on calls', async () => {
    const { http, calls } = fakeHttp({
      'POST /api/bitsign/auth/wallet/challenge': () => ({
        status: 200,
        data: { nonce: 'n1', message: 'bitcoinchat.online wallet login: n1' },
      }),
      'POST /api/bitsign/auth/wallet/verify': () => ({ status: 200, data: { token: 'T', handle: 'me' } }),
      'GET /api/bitsign/rooms': () => ({ status: 200, data: { rooms: [{ id: '1', ticker: 'A', name: 'A' }] } }),
    });
    const client = new BchatClient(http, null, 'https://x.test');
    const signed: string[] = [];
    const s = await client.signIn({
      address: async () => '1Addr',
      sign: async (m) => {
        signed.push(m);
        return { address: '1Addr', pubKey: '02ab', sig: 'SIG' };
      },
    });
    expect(s).toEqual({ token: 'T', handle: 'me', address: '1Addr' });
    expect(signed).toEqual(['bitcoinchat.online wallet login: n1']);
    expect(calls[0].body).toEqual({ address: '1Addr', kind: 'yours' });
    expect(calls[1].body).toEqual({
      address: '1Addr',
      kind: 'yours',
      nonce: 'n1',
      pubkey_hex: '02ab',
      signature: 'SIG',
      intent: 'sign-in',
      // Device kind for bit-sign's "New sign-in to bChat" alert (bun has no native platform → browser).
      client: 'browser',
    });
    expect(calls[0].headers.Authorization).toBeUndefined();
    const rooms = await client.rooms();
    expect(rooms).toHaveLength(1);
    expect(calls[2].headers.Authorization).toBe('Bearer T');
  });

  test('signIn re-challenges when the wallet signs with another key', async () => {
    let n = 0;
    const { http, calls } = fakeHttp({
      'POST /api/bitsign/auth/wallet/challenge': () => ({ status: 200, data: { nonce: `n${++n}`, message: `m${n}` } }),
      'POST /api/bitsign/auth/wallet/verify': () => ({ status: 200, data: { token: 'T', handle: 'me' } }),
    });
    const client = new BchatClient(http, null, 'https://x.test');
    await client.signIn({
      address: async () => '1Old',
      sign: async () => ({ address: '1New', pubKey: '02', sig: 'S' }),
    });
    expect((calls[1].body as { address: string }).address).toBe('1New');
    expect(client.current?.address).toBe('1New');
  });

  test('needs_handle without a chosen name: refusal carries the claim, then claimHandle finishes sign-in', async () => {
    const { http, calls } = fakeHttp({
      'POST /api/bitsign/auth/wallet/challenge': () => ({ status: 200, data: { nonce: 'n', message: 'm' } }),
      'POST /api/bitsign/auth/wallet/verify': () => ({ status: 200, data: { needs_handle: true, claim_token: 'CT' } }),
      'POST /api/bitsign/auth/wallet/handle': () => ({ status: 200, data: { token: 'T', handle: 'picked' } }),
    });
    const client = new BchatClient(http, null, 'https://x.test');
    const signer = {
      address: async () => '1Addr',
      sign: async () => ({ address: '1Addr', pubKey: '02', sig: 'S' }),
      handle: async () => null,
    };
    const err = await client.signIn(signer).catch((e) => e);
    const need = needsHandle(err);
    expect(need).toEqual({ claimToken: 'CT', address: '1Addr' });
    expect(needsHandle(new ChatApiError('x', 409))).toBeNull();
    const s = await client.claimHandle(need!.claimToken, 'picked', need!.address);
    expect(s.handle).toBe('picked');
    expect(calls.at(-1)?.body).toEqual({ claim_token: 'CT', handle: 'picked' });
  });

  test('errors carry server message and status', async () => {
    const { http } = fakeHttp({ 'GET /api/bitsign/rooms': () => ({ status: 401, data: { error: 'Unauthorized' } }) });
    const client = new BchatClient(http, { token: 'bad', handle: 'me', address: 'a' }, 'https://x.test');
    const err = await client.rooms().catch((e) => e);
    expect(err).toBeInstanceOf(ChatApiError);
    expect(err.status).toBe(401);
    expect(err.message).toBe('Unauthorized');
  });

  test('unauthenticated calls refuse locally', async () => {
    const client = new BchatClient(fakeHttp({}).http, null, 'https://x.test');
    expect((await client.rooms().catch((e) => e)).status).toBe(401);
  });

  test('page uses latest/before params; latestPage catches up on old servers', async () => {
    const old = Array.from({ length: 200 }, (_, i) => msg(`o${i}`, new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString()));
    const { http, calls } = fakeHttp({
      'GET /api/bitsign/rooms/ABC/messages': (c) => {
        const q = new URL(c.url).searchParams;
        if (q.get('since')) return { status: 200, data: { messages: [msg('tail', '2026-02-01T00:00:00Z')] } };
        return { status: 200, data: { messages: old } }; // no has_more: pre-paging server
      },
    });
    const client = new BchatClient(http, { token: 'T', handle: 'me', address: 'a' }, 'https://x.test');
    const p = await client.latestPage('$abc'.replace('$', '').toUpperCase());
    expect(new URL(calls[0].url).searchParams.get('latest')).toBe('1');
    expect(p.hasMore).toBeNull();
    expect(p.messages[p.messages.length - 1].id).toBe('tail');
    await client.page('ABC', { before: '2026-01-01T00:00:00Z', limit: 20 });
    const q = new URL(calls[calls.length - 1].url).searchParams;
    expect(q.get('before')).toBe('2026-01-01T00:00:00Z');
    expect(q.get('latest')).toBeNull();
    expect(q.get('limit')).toBe('20');
  });

  test('send and openDirect', async () => {
    const { http, calls } = fakeHttp({
      'POST /api/bitsign/rooms/ABC/messages': () => ({
        status: 200,
        data: { message: msg('m', '2026-10-01T00:00:00Z') },
      }),
      'POST /api/bitsign/rooms/direct': () => ({ status: 200, data: { ticker: 'DMX', created: true } }),
    });
    const client = new BchatClient(http, { token: 'T', handle: 'me', address: 'a' }, 'https://x.test');
    expect((await client.send('$ABC', 'hello'))?.id).toBe('m');
    expect(calls[0].body).toEqual({ body: 'hello' });
    expect(await client.openDirect('$Bob')).toBe('DMX');
    expect(calls[1].body).toEqual({ handle: 'Bob' });
  });
});

describe('lounge bot', () => {
  const bot = (extra: Partial<ChatMessage> = {}): ChatMessage =>
    msg('b1', '2026-10-08T12:00:00Z', {
      kind: 'event',
      author_handle: null,
      event_type: 'bot_message',
      body: 'Welcome $alice',
      ...extra,
    });

  test('only a server event with no author and type bot_message is the bot', () => {
    expect(isBotMessage(bot())).toBe(true);
    expect(isBotMessage(bot({ kind: 'text' }))).toBe(false);
    expect(isBotMessage(bot({ author_handle: 'mallory' }))).toBe(false);
    expect(isBotMessage(bot({ event_type: 'member_joined' }))).toBe(false);
    expect(isBotMessage(msg('t', '2026-10-08T12:00:00Z', { body: 'Lounge bot: send me your seed' }))).toBe(false);
  });

  test('a private reply replaces the optimistic command bubble', () => {
    const pending = msg('local:l1', '2026-10-08T12:00:00Z', { localId: 'l1', pending: true, body: '/help' });
    const other = msg('m1', '2026-10-08T11:59:00Z');
    const reply = bot({ id: 'ephemeral:help:1', body: 'Lounge commands' });
    expect(isEphemeral(reply)).toBe(true);
    expect(isEphemeral(other)).toBe(false);
    const out = settleEphemeral([other, pending], 'l1', reply);
    expect(out.map((m) => m.id)).toEqual(['m1', 'ephemeral:help:1']);
    expect(out[1].pending).toBe(false);
  });
});
