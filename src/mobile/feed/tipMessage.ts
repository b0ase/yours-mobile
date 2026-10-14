import { isOurDomain } from '../names/names';
import { isTxid, type FeedPost } from './post';

/**
 * An optional message sent with a Feed tip (owner, 14 Oct 2026: "tipping without a message makes no sense").
 * PURE: no wallet, no network. FeedPage's TipSheet does the sending.
 *
 * Where the message can go:
 *   reply: a bChat reply under the post, on chain (MAP context tx <post txid>). Works for any post with an
 *          on-chain txid (bChat, Twetch, Treechat, Fwetch …): it threads in bChatX. The wallet cannot post
 *          Twetch-native replies, so a Twetch post gets a bChat reply that references it.
 *   bmail: the author's bMail, when the post declares a bWalletX paymail (pki → identity key at send time).
 *   note:  a private note through the message box, when the post declares some other paymail.
 */
export const TIP_MESSAGE_MAX = 280;

export type TipDest = 'reply' | 'bmail' | 'note';
export type DestState = { available: boolean; on: boolean };
export type TipDests = Record<TipDest, DestState>;

export const DEST_LABEL: Record<TipDest, string> = {
  reply: 'Under their post',
  bmail: 'In their bMail',
  note: 'Private note',
};

/** null when fine (empty is fine: the message is optional). */
export function validateTipMessage(text: string): string | null {
  const t = text.trim();
  if ([...t].length > TIP_MESSAGE_MAX) return `Keep it to ${TIP_MESSAGE_MAX} characters.`;
  return null;
}

const domainOf = (paymail: string | undefined): string | null => {
  const m = paymail ? /^[^@\s]+@([^@\s]+)$/.exec(paymail) : null;
  return m ? m[1].toLowerCase() : null;
};

/** Which destinations exist for this post, and their defaults. */
export function tipDestinations(
  post: Pick<FeedPost, 'txid'> & { author: { paymail?: string } },
  ours: (domain: string) => boolean = (d) => isOurDomain(d),
): TipDests {
  const reply = isTxid(post.txid);
  const domain = domainOf(post.author.paymail);
  const bmail = !!domain && ours(domain);
  const note = !!domain && !bmail;
  return {
    reply: { available: reply, on: reply },
    bmail: { available: bmail, on: bmail },
    note: { available: note, on: note && !reply && !bmail },
  };
}

/** Flip one destination (unavailable ones never turn on). */
export const toggleDest = (d: TipDests, k: TipDest): TipDests =>
  d[k].available ? { ...d, [k]: { ...d[k], on: !d[k].on } } : d;

/** The destinations that will be used, in order. */
export const chosenDests = (d: TipDests): TipDest[] =>
  (['reply', 'bmail', 'note'] as const).filter((k) => d[k].available && d[k].on);

/** "Under their post · In their bMail", or '' when nothing is chosen. */
export const destSummary = (d: TipDests): string =>
  chosenDests(d)
    .map((k) => DEST_LABEL[k])
    .join(' · ');

/** A message is sent only when there is text and somewhere to send it. */
export const willSendMessage = (text: string, d: TipDests): boolean =>
  !!text.trim() && !validateTipMessage(text) && chosenDests(d).length > 0;

/** The bMail / note body: the message plus which post it was about. */
export const tipMailBody = (text: string, tipLabel: string, postTxid: string): { subject: string; body: string } => ({
  subject: `Tip: ${tipLabel}`,
  body: `${text.trim()}\n\nSent with a ${tipLabel} tip on your post ${postTxid}.`,
});
