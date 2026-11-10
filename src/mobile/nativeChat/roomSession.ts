/**
 * One open native room. The same loading and sending the WebView room does (tabs/ChatPage.tsx Conversation), minus
 * the React: cached tail first, then only what is newer; the same `client.send`, the same acknowledgement rules.
 *
 * Anything the native screen doesn't do yet goes to the full room instead of being half-done, so nothing here pays:
 * a room that charges per message gets the "open full room" composer and client.send is never called without its
 * payment. Membership and gating are the server's answer (403), not ours.
 */
import type { BchatClient, ReplyRef } from '../chat/api';
import { ChatApiError } from '../chat/api';
import { parseCommissionCommand } from '../chat/commissions';
import { showHistoryNote, HISTORY_HIDDEN_NOTE } from '../chat/history';
import {
  isEphemeral,
  latestCursor,
  mergeMessages,
  normHandle,
  oldestCursor,
  settleEphemeral,
  visibleMessages,
  type ChatMessage,
  type ChatRoom,
} from '../chat/messages';
import { openInfo } from '../chat/openRooms';
import { mustPay, type SpendCharge } from '../chat/roomSpend';
import type { GateRefusal } from '../chat/tokenRooms';
import { parseGateRefusal } from '../chat/tokenRooms';
import type { NativeComposer } from './plugin';
import { roomCacheable, threadRows, type NativeRow } from './rows';

export type RoomUpdate = {
  rows: NativeRow[];
  hasMore: boolean;
  cacheable: boolean;
  loading: boolean;
  error: string;
  composer: NativeComposer;
};

export type RoomSessionDeps = {
  client: Pick<BchatClient, 'latestPage' | 'since' | 'page' | 'send' | 'markRead'>;
  me: string;
  room: ChatRoom;
  viewerIsAdmin: boolean;
  cache: {
    peek: (me: string, ticker: string) => ChatMessage[] | null;
    read: (me: string, ticker: string) => Promise<ChatMessage[] | null>;
    write: (me: string, ticker: string, msgs: ChatMessage[]) => void;
  };
  blocked: () => string[];
  /** A token room's price per message; resolves null when free. Absent: never priced. */
  charge?: () => Promise<SpendCharge | null>;
  emit: (u: RoomUpdate) => void;
  onAuthLost: () => void;
  onLocked: (r: GateRefusal) => void;
  /** Needs the WebView room (e.g. /commission). */
  onClassic: () => void;
};

const errText = (e: unknown) => (e instanceof Error && e.message ? e.message : 'Something went wrong');

export const PRICED_NOTE = 'This room charges per message. Open the full room to post.';
export const CLOSED_NOTE = 'This room is closed.';

export class NativeRoomSession {
  private messages: ChatMessage[] = [];
  private hasMore: boolean | null = null;
  private hiddenBefore: string | null = null;
  private loading = true;
  private error = '';
  private loadingOlder = false;
  private live = true;
  private seq = 0;
  private charge: SpendCharge | null = null;
  /** The server answered 402 to a send: this room charges even though the lookup didn't say so. */
  private priced = false;
  private chargeReady: Promise<void> = Promise.resolve();

  constructor(private readonly d: RoomSessionDeps) {}

  private get ticker() {
    return this.d.room.ticker;
  }

  private composer(): NativeComposer {
    if (openInfo(this.d.room)?.closed) return { kind: 'readonly', note: CLOSED_NOTE };
    if (this.priced || mustPay(this.charge)) return { kind: 'classic', note: PRICED_NOTE };
    return { kind: 'open' };
  }

  private rows(): NativeRow[] {
    const rows = threadRows(this.messages, this.d.me, { blocked: this.d.blocked() });
    if (this.hiddenBefore && showHistoryNote(this.hiddenBefore) && this.hasMore !== true)
      rows.unshift({ id: 'note:history', type: 'system', text: HISTORY_HIDDEN_NOTE });
    else if (this.hasMore === false && rows.length)
      rows.unshift({ id: 'note:start', type: 'system', text: 'Beginning of conversation' });
    return rows;
  }

  private publish() {
    if (!this.live) return;
    this.d.emit({
      rows: this.rows(),
      hasMore: this.hasMore === true,
      cacheable: roomCacheable(this.d.room, this.messages),
      loading: this.loading,
      error: this.error,
      composer: this.composer(),
    });
  }

  private fail = (e: unknown) => {
    if (!this.live) return;
    if (e instanceof ChatApiError && e.status === 401) return this.d.onAuthLost();
    const refusal = e instanceof ChatApiError && e.status === 403 ? parseGateRefusal(e.data) : null;
    if (refusal) return this.d.onLocked(refusal);
    this.error = errText(e);
    this.publish();
  };

  private shown(ms: ChatMessage[]) {
    return visibleMessages(ms, this.d.viewerIsAdmin);
  }

  async open() {
    if (this.d.charge)
      this.chargeReady = this.d
        .charge()
        .then((c) => {
          if (!this.live) return;
          this.charge = c;
          this.publish();
        })
        .catch(() => undefined);
    const { me, cache } = this.d;
    const cached = cache.peek(me, this.ticker) ?? (await cache.read(me, this.ticker));
    if (!this.live) return;
    if (cached) {
      this.messages = mergeMessages([], this.shown(cached));
      this.hasMore = true;
      this.loading = false;
      this.publish();
      await this.fetchSince(true);
      return;
    }
    this.publish();
    try {
      const p = await this.d.client.latestPage(this.ticker);
      if (!this.live) return;
      cache.write(me, this.ticker, p.messages);
      this.messages = mergeMessages([], this.shown(p.messages));
      this.hasMore = p.hasMore;
      this.hiddenBefore = p.hiddenBefore ?? null;
      this.error = '';
      this.loading = false;
      this.publish();
      void this.d.client.markRead(this.ticker).catch(() => {});
    } catch (e) {
      this.loading = false;
      this.fail(e);
    }
  }

  private async fetchSince(reportErrors: boolean) {
    const cursor = latestCursor(this.messages);
    if (!cursor) return;
    try {
      const fresh = await this.d.client.since(this.ticker, cursor);
      if (!this.live) return;
      if (fresh.length) this.d.cache.write(this.d.me, this.ticker, fresh);
      const shown = this.shown(fresh);
      this.error = '';
      if (shown.length) {
        this.messages = mergeMessages(this.messages, shown, { dropOrphanEdits: true });
        this.publish();
        void this.d.client.markRead(this.ticker).catch(() => {});
      }
    } catch (e) {
      if (reportErrors) this.fail(e);
    }
  }

  poll = () => this.fetchSince(false);

  async older() {
    const before = oldestCursor(this.messages);
    if (!before || this.hasMore !== true || this.loadingOlder) return;
    this.loadingOlder = true;
    try {
      const p = await this.d.client.page(this.ticker, { before });
      if (!this.live) return;
      this.messages = mergeMessages(this.messages, this.shown(p.messages));
      this.hasMore = p.hasMore;
      this.hiddenBefore = p.hiddenBefore ?? this.hiddenBefore;
      this.publish();
    } catch (e) {
      this.fail(e);
    } finally {
      this.loadingOlder = false;
    }
  }

  async send(text: string) {
    const body = text.trim();
    if (!body) return;
    // /commission opens its own composer in the full room; never posted as a message.
    if (parseCommissionCommand(body)) return this.d.onClassic();
    await this.chargeReady;
    if (!this.live) return;
    if (this.composer().kind !== 'open') return this.publish();
    this.post(body);
  }

  retry(localId: string) {
    const m = this.messages.find((x) => x.localId === localId && x.failed);
    if (m?.body && this.composer().kind === 'open') this.post(m.body, m);
  }

  private post(body: string, existing?: ChatMessage) {
    const { me } = this.d;
    const localId = existing?.localId ?? `n${Date.now()}-${++this.seq}`;
    const optimistic: ChatMessage = {
      id: `local:${localId}`,
      localId,
      author_handle: me,
      kind: 'text',
      body,
      created_at: new Date().toISOString(),
      pending: true,
    };
    this.messages = this.messages.filter((m) => m.localId !== localId).concat(optimistic);
    this.publish();
    const quoting: ReplyRef | null = null;
    this.d.client
      .send(this.ticker, body, undefined, quoting)
      .then((saved) => {
        if (saved) this.d.cache.write(me, this.ticker, [saved]);
        if (saved && isEphemeral(saved)) this.messages = settleEphemeral(this.messages, localId, saved);
        else {
          const rest =
            saved && normHandle(saved.author_handle ?? '') !== normHandle(me)
              ? this.messages.filter((m) => m.localId !== localId)
              : this.messages;
          this.messages = saved ? mergeMessages(rest, [saved]) : rest;
        }
        this.publish();
      })
      .catch((e) => {
        this.messages = this.messages.map((m) => (m.localId === localId ? { ...m, failed: true } : m));
        this.publish();
        if (e instanceof ChatApiError && e.status === 402) {
          // Priced after all (the lookup missed it): nothing was spent; posting moves to the full room.
          this.priced = true;
          this.publish();
          return;
        }
        if (e instanceof ChatApiError && (e.status === 401 || e.status === 403)) this.fail(e);
      });
  }

  close() {
    this.live = false;
  }
}
