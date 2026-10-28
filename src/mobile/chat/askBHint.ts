/**
 * `$b` is public, `/b` is private (owner, 28 Oct 2026; bit-sign src/lib/ask-b-modal.ts).
 *
 * `$b` in a room posts the question to the room and b answers in front of everyone. In a room with
 * other members the chat bar says so and offers "Ask privately instead", which turns the draft into
 * `/b …`: the server keeps that question and b's answer where only the asker can read them
 * (bchat_private_messages), and the thread labels them "Only you can see this".
 */

const DOLLAR_B = /(^|\s)\$b(?:\.bot)?(?=$|[\s?!,:;)]|\.(?:\s|$))/i;

/** `$b` (or `$b.bot`) as its own word. `$bob` and `$bwalletx` are not `$b`. */
export function mentionsDollarB(text: string): boolean {
  return DOLLAR_B.test(text);
}

/** Only where someone else would see the answer: never in a room of one. */
export function showPublicBHint(draft: string, members: number): boolean {
  return members > 1 && mentionsDollarB(draft);
}

/** The draft as a private `/b` question: `$b` taken out, `/b` in front. */
export function toPrivateB(draft: string): string {
  const rest = draft
    .replace(new RegExp(DOLLAR_B.source, 'gi'), '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
  return rest ? `/b ${rest}` : '/b ';
}

export const PUBLIC_B_HINT = 'b will answer in front of everyone in this room';
export const PRIVATE_B_ACTION = 'Ask privately instead';

/** The empty chat pane's opening lines (owner, 28 Oct 2026; bit-sign askBStarters('pane')). Same b, history and threads. */
export const PANE_GREETING = 'What do you want to do?';
export const PANE_STARTERS: { label: string; prompt: string }[] = [
  { label: PANE_GREETING, prompt: 'What can I do here? Give me the options.' },
  { label: 'Start a room with someone', prompt: 'Help me start a room with someone. Ask me who and what it is for.' },
  { label: 'Find a room to join', prompt: 'Help me find a room to join. Ask me what I am interested in.' },
  {
    label: 'Catch me up on my rooms',
    prompt: 'Catch me up on my rooms: unread messages, mentions, and anything waiting for my signature.',
  },
  {
    label: 'Draft a contract or offer in a room',
    prompt: 'Help me draft a contract or an offer in one of my rooms. Ask me which room and what it is.',
  },
];
