import { describe, expect, test } from 'bun:test';
import * as bip39 from 'bip39';
import { looksLikeSecret } from '../agent/agent';
import { redactSecrets } from './errorReport';
import { containsPhrase, hidePhrases } from './phraseGuard';

const W12 = 'abandon ability able about above absent absorb abstract absurd abuse access accident'.split(' ');
const W24 = bip39.generateMnemonic(256).split(' ');
/**
 * A 24-word phrase that starts with "hidden": a BIP39 word that is also in the placeholder "[recovery words hidden]".
 * A random W24 holds it about 1 run in 85, and the left-over check used to read the placeholder's "hidden" as a word
 * left in the clear (full-suite loop, 5 Nov 2026: three "24 …" cases failed together).
 */
const HIDDEN24 = (() => {
  const bits = bip39.wordlists.english.indexOf('hidden').toString(2).padStart(11, '0').padEnd(256, '0');
  const hex = bits.replace(/[01]{4}/g, (n) => parseInt(n, 2).toString(16));
  return bip39.entropyToMnemonic(hex).split(' ');
})();
/** The words of the phrase still readable after redaction (the placeholder itself never counts). */
const leftOver = (out: string, words: string[]) =>
  out
    .replaceAll('[recovery words hidden]', ' ')
    .split(/[^a-z]+/)
    .filter((w) => words.includes(w));
const grid = (w: string[], cols: number) =>
  Array.from({ length: Math.ceil(w.length / cols) }, (_, r) => w.slice(r * cols, r * cols + cols).join('   ')).join(
    '\n',
  );

const FORMATS: Array<[string, string]> = [
  ['plain', W12.join(' ')],
  ['numbered dot', W12.map((w, i) => `${i + 1}. ${w}`).join(' ')],
  ['numbered paren', W12.map((w, i) => `${i + 1}) ${w}`).join(' ')],
  ['numbered colon', W12.map((w, i) => `${i + 1}: ${w}`).join(' ')],
  ['numbered no space', W12.map((w, i) => `${i + 1}.${w}`).join(' ')],
  ['zero padded', W12.map((w, i) => `${String(i + 1).padStart(2, '0')}. ${w}`).join(' ')],
  ['newline per word', W12.join('\n')],
  ['numbered newline per word', W12.map((w, i) => `${i + 1}. ${w}`).join('\n')],
  ['3x4 grid', grid(W12, 4)],
  ['4x3 grid', grid(W12, 3)],
  [
    'numbered 3x4 grid',
    grid(
      W12.map((w, i) => `${i + 1}. ${w}`),
      4,
    ),
  ],
  ['uppercase', W12.join(' ').toUpperCase()],
  ['capitalised numbered', W12.map((w, i) => `${i + 1}. ${w[0].toUpperCase()}${w.slice(1)}`).join(' ')],
  ['partial numbering', W12.map((w, i) => (i % 3 === 0 ? `${i + 1}. ${w}` : w)).join(' ')],
  ['dash separated', W12.join(' - ')],
  ['dash joined', W12.join('-')],
  ['bullets', W12.map((w) => `• ${w}`).join('\n')],
  ['comma separated', W12.join(', ')],
  ['label prefix', `seed: ${W12.join(' ')}`],
  ['words label', `my words: ${W12.join(' ')}`],
  ['24 words', W24.join(' ')],
  ['24 numbered', W24.map((w, i) => `${i + 1}. ${w}`).join(' ')],
  [
    '24 grid',
    grid(
      W24.map((w, i) => `${i + 1}. ${w}`),
      3,
    ),
  ],
];

describe('recovery phrases in any format', () => {
  for (const [name, text] of FORMATS) {
    test(`redactSecrets hides every word: ${name}`, () => {
      const out = redactSecrets(`Restore failed: ${text}`).toLowerCase();
      expect(out).toContain('[recovery words hidden]');
      expect(leftOver(out, name.startsWith('24') ? W24 : W12)).toEqual([]);
    });
    test(`Ask b refuses it: ${name}`, () => {
      expect(looksLikeSecret(text)).toBe(true);
    });
  }
  test('a phrase holding "hidden" (also a word of the placeholder) is still all hidden, every run', () => {
    expect(HIDDEN24[0]).toBe('hidden');
    expect(bip39.validateMnemonic(HIDDEN24.join(' '))).toBe(true);
    for (const text of [HIDDEN24.join(' '), HIDDEN24.map((w, i) => `${i + 1}. ${w}`).join(' ')]) {
      const out = redactSecrets(`Restore failed: ${text}`).toLowerCase();
      expect(out).toContain('[recovery words hidden]');
      expect(leftOver(out, HIDDEN24)).toEqual([]);
    }
  });
  test('numbering is hidden with the words', () => {
    const out = redactSecrets(W12.map((w, i) => `${i + 1}. ${w}`).join(' '));
    expect(out).toBe('[recovery words hidden]');
  });
});

describe('ordinary text is left alone', () => {
  const PROSE = [
    'I tried to send some money to my friend yesterday but the app said the transaction failed. Can you tell me what happened and how to fix it?',
    'The wallet was working fine this morning. After the update the balance page shows a blank screen and the back button does nothing at all.',
    'We will be away on holiday for a few weeks, so please keep an eye on the account and let me know if anything strange appears in the history.',
    'Before you start, open the menu, choose settings, then pick the theme you like. There is also an option to change the language of the app.',
    'Please add a dark mode, a way to export my history as a file, and a simple guide for new people who have never used a bitcoin wallet before.',
  ];
  for (const p of PROSE) {
    test(`not flagged: ${p.slice(0, 30)}…`, () => {
      expect(containsPhrase(p)).toBe(false);
      expect(looksLikeSecret(p)).toBe(false);
      expect(redactSecrets(p)).not.toContain('[recovery words hidden]');
    });
  }
  test('a few BIP39 words in a sentence', () => {
    const s =
      'My phone has a crack across the screen so I need to buy a new one, any advice about which wallet app to install?';
    expect(containsPhrase(s)).toBe(false);
    expect(looksLikeSecret(s)).toBe(false);
  });
  test('a short list of BIP39 words', () => {
    const s = 'Ideas for the store: apple, banana, orange, lemon and a coffee theme.';
    expect(containsPhrase(s)).toBe(false);
    expect(redactSecrets(s)).toBe(s);
  });
});

/** Every letter run in `out` that is one of `words` (NFKD, accents kept or dropped): the words left readable. */
const leftOverAny = (out: string, words: string[]) => {
  const plain = (w: string) => w.normalize('NFKD').toLowerCase().replace(/\p{M}/gu, '');
  const want = new Set(words.flatMap((w) => [w.normalize('NFKD').toLowerCase(), plain(w)]));
  return Array.from(
    out
      .replaceAll('[recovery words hidden]', ' ')
      .normalize('NFKD')
      .matchAll(/[\p{L}\p{M}]+/gu),
    (m) => m[0].toLowerCase(),
  ).filter((w) => want.has(w) || want.has(plain(w)));
};
const expectBlocked = (text: string, words: string[]) => {
  expect(looksLikeSecret(text)).toBe(true);
  const out = redactSecrets(`Restore failed: ${text}`);
  expect(out).toContain('[recovery words hidden]');
  expect(leftOverAny(out, words)).toEqual([]);
};

describe('recovery phrases joined by any punctuation (b-Aware 634, row 353)', () => {
  const SEPS = [
    ':',
    '=',
    ' : ',
    ' = ',
    '::',
    '=>',
    '->',
    '>',
    '<',
    '#',
    '@',
    '~',
    '!',
    '?',
    '&',
    '^',
    '%',
    '$',
    '"',
    "'",
    '`',
    '\t',
    '   ',
  ];
  for (const sep of SEPS) test(`joined by ${JSON.stringify(sep)}`, () => expectBlocked(W12.join(sep), W12));
  test('each word wrapped in brackets or quotes', () => {
    expectBlocked(W12.map((w) => `(${w})`).join(''), W12);
    expectBlocked(W12.map((w) => `[${w}]`).join(''), W12);
    expectBlocked(W12.map((w) => `"${w}"`).join(','), W12);
    expectBlocked(W12.map((w) => `{${w}}`).join(''), W12);
  });
  test('word=word key/value pairs and numbered word:N', () => {
    expectBlocked(W12.map((w, i) => `w${i + 1}=${w}`).join('&'), W12);
    expectBlocked(W12.map((w, i) => `${w}:${i + 1}`).join(' '), W12);
  });
  test('24 words colon-joined', () => expectBlocked(W24.join(':'), W24));
});

describe('recovery phrases with filler words between them (b-Aware 634, row 353)', () => {
  test('the same filler between every word (the report: abandon zz ability zz …)', () =>
    expectBlocked(W12.join(' zz '), W12));
  test('two fillers between every word', () => expectBlocked(W12.join(' zz qq '), W12));
  test('a two-column note: "word N" labels between the words', () =>
    expectBlocked(W12.map((w, i) => `word ${i + 1} ${w}`).join('\n'), W12));
  test('a valid phrase with a different filler between each word', () => {
    const phrase = bip39.generateMnemonic(128).split(' ');
    const fill = ['zq', 'xv', 'kj', 'qx', 'vv', 'jz', 'xq', 'zx', 'qj', 'kx', 'jx', 'vq'];
    expectBlocked(phrase.map((w, i) => `${w} ${fill[i]}`).join(' '), phrase);
  });
});

/** The nine non-English BIP39 wordlists (b-Aware 657, row 364). bip39 joins Japanese with U+3000. */
const OTHER_LISTS = [
  'spanish',
  'french',
  'italian',
  'portuguese',
  'czech',
  'japanese',
  'korean',
  'chinese_simplified',
  'chinese_traditional',
] as const;

describe('recovery phrases in every BIP39 language (b-Aware 657, row 364)', () => {
  test("the reporter's Japanese phrase, as the report ran it: looksLikeSecret(jp) and hidePhrases(jp)", () => {
    // As it arrived by email, two of the twelve words ("しゅうかい", "あわう") are not in the list: a phrase with typos.
    const jp = 'ごうい すもう あこがれる くろう なふだ うすぎ せめる はいち すくう ていど しゅうかい あわう';
    expect(looksLikeSecret(jp)).toBe(true);
    expect(hidePhrases(jp)).toBe('[recovery words hidden]');
  });
  for (const lang of OTHER_LISTS) {
    const list = bip39.wordlists[lang];
    for (const bits of [128, 256]) {
      const words = bip39.generateMnemonic(bits, undefined, list).normalize('NFC').split(/\s+/); // \s takes in U+3000, the space bip39 puts between Japanese words
      const forms: Array<[string, string]> = [
        ['plain', words.join(' ')],
        ['as bip39 writes it', bip39.entropyToMnemonic(bip39.mnemonicToEntropy(words.join(' '), list), list)],
        ['numbered', words.map((w, i) => `${i + 1}. ${w}`).join(' ')],
        ['one per line', words.join('\n')],
        [
          'numbered grid',
          grid(
            words.map((w, i) => `${i + 1}. ${w}`),
            3,
          ),
        ],
        ['colon-joined', words.join(':')],
        ['equals-joined', words.join('=')],
        ['filler between words', words.join(' zz ')],
      ];
      if (/^[\p{Script=Latin}]/u.test(words[0]))
        forms.push(['accents dropped', words.map((w) => w.normalize('NFKD').replace(/\p{M}/gu, '')).join(' ')]);
      for (const [name, text] of forms)
        test(`${lang} ${(bits / 32) * 3} words, ${name}`, () => expectBlocked(text, words));
    }
  }
});

describe('ordinary text in other languages, and punctuation-heavy text, is left alone', () => {
  const PROSE = [
    'Hola, intenté enviar dinero a mi amigo ayer pero la aplicación dijo que la transacción falló. ¿Me puedes ayudar a entender qué pasó y cómo arreglarlo?',
    "Bonjour, j'ai essayé d'envoyer de l'argent à un ami hier mais l'application a dit que la transaction avait échoué. Pouvez-vous m'aider à comprendre pourquoi ?",
    "Ciao, ieri ho provato a mandare dei soldi a un amico ma l'applicazione ha detto che la transazione non è andata a buon fine. Potete aiutarmi a capire perché?",
    'Olá, tentei enviar dinheiro para um amigo ontem mas o aplicativo disse que a transação falhou. Vocês podem me ajudar a entender o que aconteceu e como resolver?',
    'Dobrý den, včera jsem se pokusil poslat peníze kamarádovi, ale aplikace napsala, že transakce selhala. Můžete mi prosím pomoci pochopit, co se stalo?',
    '昨日友達にお金を送ろうとしましたが、アプリが取引に失敗したと表示しました。何が起きたのか、どうすれば直せるのか教えてください。',
    '어제 친구에게 돈을 보내려고 했는데 앱에서 거래가 실패했다고 나왔습니다. 무슨 일이 있었는지, 어떻게 고칠 수 있는지 알려주세요.',
    '我昨天想给朋友转账，但是应用显示交易失败了。你能告诉我发生了什么，以及怎么解决吗？谢谢！',
    '我昨天想給朋友轉帳，但是應用顯示交易失敗了。你能告訴我發生了什麼，以及怎麼解決嗎？謝謝！',
    'Error: request failed: status=500; url=https://api.example.com/v1/send?amount=10&fee=1; retry=true; mode=fast; theme=dark',
    'Settings: theme = gold; language = english; lock = never; currency = usd; network = main; sound = off; alerts = on',
    'Step 1: open the menu. Step 2: choose settings. Step 3: pick a theme. Step 4: tap save. Step 5: close the app and open it again.',
  ];
  for (const p of PROSE)
    test(`not flagged: ${p.slice(0, 30)}…`, () => {
      expect(containsPhrase(p)).toBe(false);
      expect(looksLikeSecret(p)).toBe(false);
      expect(redactSecrets(p)).not.toContain('[recovery words hidden]');
    });
});

/** A valid 12-word phrase that does not itself use any of `avoid` (so a test's filler words are only filler). */
const phraseAvoiding = (avoid: string[]) => {
  for (;;) {
    const words = bip39.generateMnemonic(128).split(' ');
    if (!words.some((w) => avoid.includes(w))) return words;
  }
};

describe('filler words that are themselves BIP39 words (review of b-Aware row 353)', () => {
  const ORD = ['st', 'nd', 'rd'];
  const CASES: Array<[string, string[], (w: string[]) => string]> = [
    ['"word N is X."', ['word'], (w) => w.map((x, i) => `word ${i + 1} is ${x}.`).join(' ')],
    ['"1st word: X,"', ['word'], (w) => w.map((x, i) => `${i + 1}${ORD[i] ?? 'th'} word: ${x},`).join(' ')],
    ['"the X then"', ['then'], (w) => w.map((x) => `the ${x} then`).join(' ')],
    ['JSON index/value objects', ['index', 'value'], (w) => JSON.stringify(w.map((x, i) => ({ index: i, value: x })))],
    ['"first X then"', ['first', 'then'], (w) => w.map((x) => `first ${x} then`).join(' ')],
    ['"word: X" one per line', ['word'], (w) => w.map((x) => `word: ${x}`).join('\n')],
  ];
  for (const [name, avoid, make] of CASES)
    test(`blocked: ${name}`, () => {
      for (let run = 0; run < 5; run++) {
        const words = phraseAvoiding(avoid);
        expectBlocked(make(words), words);
      }
    });
  test('a 24-word phrase with "word N" labels', () => {
    let words = bip39.generateMnemonic(256).split(' ');
    while (words.includes('word')) words = bip39.generateMnemonic(256).split(' ');
    expectBlocked(words.map((x, i) => `word ${i + 1}: ${x}`).join(', '), words);
  });
});

describe('the guard is fast on long word-heavy text (review of b-Aware row 353)', () => {
  const en = bip39.wordlists.english;
  // Fixed, not random, so a run is repeatable: every 7th list word.
  const listWords = (n: number) => Array.from({ length: n }, (_, i) => en[(i * 7) % 2048]);
  const timed = (f: () => unknown) => {
    const a = performance.now();
    f();
    return performance.now() - a;
  };
  // The base (before this branch) took 24ms on 20,000 such words; the first fix took 16s. The bounds leave room for
  // a loaded machine.
  test('20,000 list words in a row', () => {
    const text = listWords(20000).join(' ');
    expect(timed(() => hidePhrases(text))).toBeLessThan(1500);
    expect(timed(() => containsPhrase(text))).toBeLessThan(1500);
  });
  test('20,000 list words with a different filler after each', () => {
    const text = listWords(20000)
      .map((w, i) => `${w} q${i.toString(36)}`)
      .join(' ');
    expect(timed(() => hidePhrases(text))).toBeLessThan(1500);
  });
  test('a long error is redacted quickly and still hides a phrase near the start', () => {
    const text = `Restore failed: ${W12.join(' ')}. ${listWords(50000).join(' ')}`;
    let out = '';
    expect(timed(() => (out = redactSecrets(text)))).toBeLessThan(1500);
    expect(out).toContain('[recovery words hidden]');
    expect(out.length).toBeLessThanOrEqual(1200);
  });
});
