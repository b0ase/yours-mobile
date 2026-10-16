/**
 * Pre-signed payments — local store (docs/PRESIGNED-PAYMENTS.md §4.2, §6).
 *
 * Holds sets and slot states on the device. No private keys and no pre-sigs are
 * stored: P, R are re-derived from the seed, and the only signed tx kept is a
 * refund, which can only pay the payer.
 */
export type SlotState = 'open' | 'claiming' | 'claimed' | 'refunding' | 'refunded' | 'spent';

export interface StoredSlot {
  index: number;
  satoshis: number;
  lockingScriptHex: string;
  /** `txid.vout` once the creation tx exists */
  outpoint?: string;
  token?: { id: string; amt: string };
  state: SlotState;
  recipient?: string;
  claimTxid?: string;
  refundRawHex?: string;
  refundTxid?: string;
  lastError?: string;
}

export interface StoredSet {
  id: string;
  kind: 'named-invite' | 'subscription' | 'payout' | 'proof';
  scope: 0xc2 | 0xc3;
  servicePubHex: string;
  createdHeight: number;
  until: number;
  creationTxid?: string;
  /** keep the creation tx so refunds can be built offline (BEEF or raw hex) */
  creationRawHex?: string;
  autoReturn: boolean;
  slots: StoredSlot[];
  scriptVersion: 1;
}

export interface KV {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
}

export function memoryKV(): KV & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    get: async (k) => data.get(k) ?? null,
    set: async (k, v) => {
      data.set(k, v);
    },
  };
}

const KEY = 'presign:sets:v1';

const ALLOWED: Record<SlotState, SlotState[]> = {
  open: ['claiming', 'claimed', 'refunding', 'refunded', 'spent'],
  claiming: ['open', 'claimed', 'spent'],
  claimed: [],
  refunding: ['refunded', 'spent', 'open'],
  refunded: [],
  spent: [],
};

export class PresignStore {
  constructor(private kv: KV) {}

  async all(): Promise<StoredSet[]> {
    const raw = await this.kv.get(KEY);
    if (!raw) return [];
    try {
      const v = JSON.parse(raw) as StoredSet[];
      return Array.isArray(v) ? v : [];
    } catch {
      return [];
    }
  }

  private async write(sets: StoredSet[]) {
    await this.kv.set(KEY, JSON.stringify(sets));
  }

  async get(id: string): Promise<StoredSet | undefined> {
    return (await this.all()).find((s) => s.id === id);
  }

  async put(set: StoredSet): Promise<void> {
    const sets = await this.all();
    const i = sets.findIndex((s) => s.id === set.id);
    if (i >= 0) sets[i] = set;
    else sets.push(set);
    await this.write(sets);
  }

  /** Move one slot to a new state; refuses illegal transitions. */
  async update(setId: string, index: number, to: SlotState, patch: Partial<StoredSlot> = {}): Promise<StoredSlot> {
    const sets = await this.all();
    const set = sets.find((s) => s.id === setId);
    const slot = set?.slots.find((s) => s.index === index);
    if (!set || !slot) throw new Error(`presign: no slot ${setId}:${index}`);
    if (slot.state !== to && !ALLOWED[slot.state].includes(to)) {
      throw new Error(`presign: slot ${setId}:${index} cannot go ${slot.state} → ${to}`);
    }
    Object.assign(slot, patch, { state: to, index });
    await this.write(sets);
    return slot;
  }

  /** Slots still holding money, across all sets. */
  async openSlots(): Promise<{ set: StoredSet; slot: StoredSlot }[]> {
    const out: { set: StoredSet; slot: StoredSlot }[] = [];
    for (const set of await this.all()) {
      for (const slot of set.slots) if (slot.state === 'open' || slot.state === 'refunding') out.push({ set, slot });
    }
    return out;
  }
}
