import { BSPACES_ENABLED, MARKET_ENABLED, SUBSCRIPTIONS_ENABLED } from '../storeBuild';

/**
 * Ask b's rotating subtitle lines (owner, 12 Oct 2026: ~100, shuffled). Each is something b can walk you through
 * or answer today (guide.ts, agent accounts in agents/agentTrade.ts). Tapping one only fills the bar; nothing is
 * sent or paid for until Send. No investment wording. Store-hidden topics are gated (storeBuild.ts).
 */
export type IdeaTopic =
  | 'Money & pots'
  | 'Trading'
  | 'Tokens'
  | 'Spaces'
  | 'Music'
  | 'bPics'
  | 'Chat'
  | 'Security & backup'
  | 'Getting started'
  | 'Builders';
export type Idea = { topic: IdeaTopic; label: string };

const T = (topic: IdeaTopic, labels: string[]): Idea[] => labels.map((label) => ({ topic, label }));

export const IDEAS: Idea[] = [
  ...T('Getting started', [
    'What can you help me with?',
    'Show me around bWalletX',
    'Claim your free $name',
    'What is my paymail?',
    'How do I receive BSV?',
    'Where do I find my QR code?',
    'Switch between accounts',
    'Add a second account',
    'What is the Feed?',
    'What are bApps?',
    'Change the currency I see',
    'Turn off video autoplay',
    'How do I install the Desktop app?',
    'What does the gold b do?',
  ]),
  ...T('Money & pots', [
    'Set up a pot for each of your kids',
    'Send money to a $handle',
    'Lock some BSV until next year',
    'Set up pocket money',
    'Make a savings pot for a holiday',
    'Send BSV to a paymail',
    'Check an address before sending',
    'What is MNEE?',
    'See locked BSV and when it unlocks',
    'What is one-click pay?',
    'Set my one-click pay limit',
    'Tip someone on the Feed',
    'Lock BSV behind a post',
    'Why did a payment fail?',
    'How big are network fees?',
    ...(SUBSCRIPTIONS_ENABLED ? ['Plan a monthly subscription', 'Cancel a regular payment'] : []),
  ]),
  ...(MARKET_ENABLED
    ? [
        ...T('Trading', [
          'Develop a trading strategy with b',
          'Set limits on an agent account',
          'Load a strategy into an agent account',
          'List my strategy on the Exchange',
          'Compare strategy listings',
          'Buy some of a token',
          'Sell a token I hold',
          'Set a stop for my strategy',
          'Curious about a token?',
        ]),
        ...T('Tokens', [
          'Launch a token for your community',
          'Mint a ticket for an event',
          'What is a BSV-21 token?',
          'Why does only one token have a ✓?',
          'Sell a ticket I hold',
          'Cancel a token listing',
          'What is token indexing?',
          'Invite someone with a ticket',
        ]),
      ]
    : []),
  ...(BSPACES_ENABLED
    ? T('Spaces', [
        'Find a Space to join tonight',
        'Start a live Space in my room',
        'Invite speakers to my Space',
        'Mute myself in a Space',
        'Share a link to my Space',
        'Pin my Space to my profile',
      ])
    : []),
  ...(MARKET_ENABLED
    ? T('Music', [
        'Back an album on bMusic',
        'Mint a song as an NFT',
        'Play the music I own',
        'Share a track with a friend',
        'Put my album on bMusic',
      ])
    : []),
  ...T('bPics', [
    'Mint a picture as an NFT',
    'Mint a photo to bPics',
    'Find my pictures in the NFTs view',
    'Send an NFT to a friend',
    'Mint a document on-chain',
    'Make a video NFT',
  ]),
  ...T('Chat', [
    'Invite a friend to your room',
    'Open my personal room',
    'Why did a room disappear?',
    'Start a call in a room',
    'Post a bounty in a room',
    'Block or mute someone',
    'Report a post',
    'Find my bookmarks',
    'Reply to a post on the Feed',
    'Quote a post',
    'Follow someone',
  ]),
  ...T('Security & backup', [
    'Back up your wallet safely',
    'Move coins from an old wallet',
    'Turn on Face ID or fingerprint unlock',
    'Change my password',
    'What if I lose my phone?',
    'Is this approval safe to allow?',
    'Spot a fake token',
    'Explain this transaction',
    'Decode a transaction',
    'Sweep a private key into the wallet',
    'Restore from SimplyCash',
    'What should I never share?',
  ]),
  ...T('Builders', [
    'Connect a BSV app to my wallet',
    'What is BRC-100?',
    'Connect the CLI and MCP',
    'Use my own AI key for b',
    'Open a dApp in the browser',
    'What does a connect request ask for?',
    'Report a bug to b',
    'Something not working? Let’s fix it',
  ]),
];

/** The same ideas in a random order (one shuffle per page load). */
export const shuffled = <X>(xs: readonly X[], rand: () => number = Math.random): X[] => {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

/** What goes into the bar when an idea is tapped. */
export const ideaPrompt = (label: string) => `${label} Walk me through it.`;
