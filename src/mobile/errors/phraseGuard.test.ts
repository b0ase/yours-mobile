import { describe, expect, test } from 'bun:test';
import { createHash } from 'crypto';
import * as bip39 from 'bip39';
import { looksLikeSecret } from '../agent/agent';
import { redactSecrets } from './errorReport';
import { containsPhrase, hidePhrases } from './phraseGuard';

const W12 = 'abandon ability able about above absent absorb abstract absurd abuse access accident'.split(' ');
const W24 = bip39.generateMnemonic(256).split(' ');

/**
 * Fixed valid phrases, the same every run (a random phrase made the tests below flaky: about 1 in 30 repeats a word).
 * Phrase k comes from sha256("phrase-guard-<k>"); phrases using any word of `avoid` are skipped.
 */
const fixedPhrases = (count: number, bits: 128 | 256, avoid: string[] = [], list?: string[], tag = ''): string[][] => {
  const out: string[][] = [];
  for (let k = 0; out.length < count; k++) {
    const hex = createHash('sha256')
      .update(`phrase-guard-${tag}${bits}-${k}`)
      .digest('hex')
      .slice(0, bits / 4);
    const words = bip39.entropyToMnemonic(hex, list).normalize('NFC').split(/\s+/); // \s takes in U+3000 (Japanese)
    if (!words.some((w) => avoid.includes(w))) out.push(words);
  }
  return out;
};
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
  // A different filler between each word: fixed phrases, below (a random one failed about 1 run in 30).
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
      const [words] = fixedPhrases(1, bits as 128 | 256, [], list, lang);
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

/** The run-th fixed 12-word phrase that does not itself use any of `avoid` (so a test's filler words are only filler). */
const phraseAvoiding = (avoid: string[], run: number) => fixedPhrases(run + 1, 128, avoid)[run];

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
      for (let run = 0; run < 20; run++) {
        const words = phraseAvoiding(avoid, run);
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
  // Before this fix: 18s on 20,000 list words in a row, about 20s on 5,000 with a filler after each (quadratic). Now
  // under 100ms and about 200ms. The bounds leave room for a loaded machine.
  test('20,000 list words in a row', () => {
    const text = listWords(20000).join(' ');
    expect(timed(() => hidePhrases(text))).toBeLessThan(2000);
    expect(timed(() => containsPhrase(text))).toBeLessThan(2000);
  });
  test('5,000 list words with a different filler after each', () => {
    const text = listWords(5000)
      .map((w, i) => `${w} q${i.toString(36)}`)
      .join(' ');
    expect(timed(() => hidePhrases(text))).toBeLessThan(2000);
  });
  test('a long error is redacted quickly and still hides a phrase near the start', () => {
    const text = `Restore failed: ${W12.join(' ')}. ${listWords(50000).join(' ')}`;
    let out = '';
    expect(timed(() => (out = redactSecrets(text)))).toBeLessThan(2000);
    expect(out).toContain('[recovery words hidden]');
    expect(out.length).toBeLessThanOrEqual(1200);
  });
  test('a phrase cut in two where the scan stops is still hidden when hiding shrank the text before it', () => {
    // Recovery words are looked for in the first 20,000 characters first. Here they hide down to one placeholder,
    // and the next phrase straddles character 20,000: its first words alone would be too few to find.
    const block = W24.map((w, i) => `${i + 1}. ${w}`).join('\n');
    let prefix = '';
    while (prefix.length + block.length + 1 < 19900) prefix += `${block}\n`;
    const text = `${prefix.padEnd(19950, ' ')}qqq rrr sss ${W12.join(' ')} done`;
    expect(text.indexOf(W12[0])).toBeLessThan(20000);
    expect(text.indexOf(W12[11])).toBeGreaterThan(20000);
    const out = redactSecrets(text).toLowerCase();
    expect(leftOver(out, W12)).toEqual([]);
    expect(out).toContain('done');
  });
});

/**
 * A fixed 12-word phrase with `word` at each position in `at` (0 to 10). "balance", and "total" are BIP39 words and also start
 * the balance redaction ("balance … 9" becomes "balance [amount hidden]"), which ran before the phrase guard and ate the
 * numbering or label after them, so the guard no longer saw a phrase (random JSON index/value case, 22 Nov 2026).
 */
const phraseWith = (word: string, ...at: number[]) => {
  let bits = '9e41c7b25d08f3a6e17c4b92d05a8f36'.replace(/./g, (h) => parseInt(h, 16).toString(2).padStart(4, '0'));
  const idx = bip39.wordlists.english.indexOf(word).toString(2).padStart(11, '0');
  for (const a of at) bits = bits.slice(0, a * 11) + idx + bits.slice(a * 11 + 11);
  return bip39.entropyToMnemonic(bits.replace(/[01]{4}/g, (n) => parseInt(n, 2).toString(16))).split(' ');
};

describe('phrase words that start the balance redaction (review of b-Aware row 353)', () => {
  const CASES: Array<[string, (w: string[]) => string]> = [
    ['JSON index/value objects', (w) => JSON.stringify(w.map((x, i) => ({ index: i, value: x })))],
    ['numbered "N. X"', (w) => w.map((x, i) => `${i + 1}. ${x}`).join(' ')],
    ['"word N is X."', (w) => w.map((x, i) => `word ${i + 1} is ${x}.`).join(' ')],
  ];
  for (const word of ['balance', 'total'])
    for (const [name, make] of CASES)
      test(`"${word}" in the phrase, ${name}`, () => {
        const words = phraseWith(word, 8);
        expect(new Set(words).size).toBe(12);
        expect(bip39.validateMnemonic(words.join(' '))).toBe(true);
        expectBlocked(make(words), words);
      });
});

describe('phrase words that start the secret-label redaction (review of b-Aware row 353)', () => {
  // "seed", "pass" and "secret" are BIP39 words: "seed:X:Y…" became "seed: [hidden]" before the phrase guard ran, and
  // the six words before it were left in the clear. No "Restore failed:" prefix here: "restore" is a list word too and
  // made up the count.
  for (const word of ['seed', 'pass', 'secret'])
    for (const sep of [':', '='])
      test(`"${word}" in a phrase joined by ${JSON.stringify(sep)}`, () => {
        const words = phraseWith(word, 6);
        expect(new Set(words).size).toBe(12);
        const text = words.join(sep);
        expect(looksLikeSecret(text)).toBe(true);
        const out = redactSecrets(text);
        expect(out).toContain('[recovery words hidden]');
        expect(leftOverAny(out, words)).toEqual([]);
      });
});

describe('ordinal numbering with a phrase that repeats a word (review of b-Aware row 353)', () => {
  // About 1 valid phrase in 30 repeats a word. "1st word: X, 2nd word: Y" left "st", "nd", "rd" and "th" as four
  // different fillers, so only the checksum pass (which needs different words) could find it: 1 in 30 escaped, and the
  // random "1st word" test above failed about 1 run in 6.
  const repeating = phraseWith('ocean', 2, 9);
  test('"1st word: X," with a repeated word', () => {
    expect(new Set(repeating).size).toBe(11);
    expectBlocked(repeating.map((x, i) => `${i + 1}${['st', 'nd', 'rd'][i] ?? 'th'} word: ${x},`).join(' '), repeating);
  });
});

const SPELLED_ORDINALS = [
  'first',
  'second',
  'third',
  'fourth',
  'fifth',
  'sixth',
  'seventh',
  'eighth',
  'ninth',
  'tenth',
  'eleventh',
  'twelfth',
  'thirteenth',
  'fourteenth',
  'fifteenth',
  'sixteenth',
  'seventeenth',
  'eighteenth',
  'nineteenth',
  'twentieth',
  'twenty-first',
  'twenty-second',
  'twenty-third',
  'twenty-fourth',
];
const SPELLED_CARDINALS = [
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'eleven',
  'twelve',
  'thirteen',
  'fourteen',
  'fifteen',
  'sixteen',
  'seventeen',
  'eighteen',
  'nineteen',
  'twenty',
  'twenty-one',
  'twenty-two',
  'twenty-three',
  'twenty-four',
];
/** "1st", "2nd", "3rd", "4th" … "11th" … "21st" for list position i (from 0). */
const nth = (i: number) => {
  const n = i + 1;
  const end = n % 100 >= 11 && n % 100 <= 13 ? 'th' : (['th', 'st', 'nd', 'rd'][n % 10] ?? 'th');
  return `${n}${end}`;
};

/**
 * Phrases that hold the label words and spelled numbers themselves: "the fifth word is three", "word 4 is word", "word one
 * is two". The labelled-list tests once skipped every such phrase, which hid a leak of about 1 list in 16 at 12 words
 * and 1 in 9 at 24 (round-4 review of b-Aware row 353).
 */
const HOLDS_LABELS = [
  phraseWith('word', 3),
  phraseWith('three', 4),
  phraseWith('one', 0),
  phraseWith('two', 0),
  phraseWith('one', 6),
  phraseWith('first', 5),
  phraseWith('second', 1),
  phraseWith('number', 2),
  phraseWith('six', 4),
  phraseWith('twelve', 10),
  phraseWith('word', 0, 7),
];

describe('plain-English labelled lists (round-3 review of b-Aware row 353)', () => {
  const CASES: Array<[string, (w: string[]) => string]> = [
    ['"my 1st word is X, my 2nd word is Y"', (w) => w.map((x, i) => `my ${nth(i)} word is ${x}`).join(', ')],
    [
      '"the first word is X. the second word is Y."',
      (w) => w.map((x, i) => `the ${SPELLED_ORDINALS[i]} word is ${x}.`).join(' '),
    ],
    ['"the 1st one is X; the 2nd one is Y"', (w) => w.map((x, i) => `the ${nth(i)} one is ${x}`).join('; ')],
    ['"word one is X, word two is Y"', (w) => w.map((x, i) => `word ${SPELLED_CARDINALS[i]} is ${x}`).join(', ')],
    ['"First: X. Second: Y." (no repeated label)', (w) => w.map((x, i) => `${SPELLED_ORDINALS[i]}: ${x}.`).join(' ')],
    ['"number one is X, number two is Y"', (w) => w.map((x, i) => `number ${SPELLED_CARDINALS[i]} is ${x}`).join(', ')],
  ];
  for (const bits of [128, 256] as const)
    for (const [name, make] of CASES)
      test(`blocked, ${bits === 128 ? 12 : 24} words: ${name}`, () => {
        const phrases = [...fixedPhrases(25, bits)];
        if (bits === 128) phrases.push(phraseWith('ocean', 2, 9), ...HOLDS_LABELS);
        for (const words of phrases) expectBlocked(make(words), words);
      });
  test('ordinary text with spelled numbers is left alone', () => {
    for (const p of [
      'The first time I opened the app it asked for a name. The second time it showed my balance. The third time it crashed.',
      'Step one: open the menu. Step two: choose settings. Step three: pick a theme. Step four: tap save. Step five: close it.',
      'I sent one payment of ten dollars, then two more of twenty, then three of seven, and the twelfth one never arrived at all.',
      'My first word to b was hello, my second word was thanks, and my third word was a question about the price of the token.',
    ]) {
      expect(containsPhrase(p)).toBe(false);
      expect(looksLikeSecret(p)).toBe(false);
    }
  });
});

describe('labelled lists joined with "and" (round-4 review of b-Aware row 353)', () => {
  // "and", "the" and "is" made three other words in a row between two phrase words, past MAX_GAP: 200 of 200 got
  // through Ask b, Copy and Report.
  const CASES: Array<[string, (w: string[]) => string]> = [
    [
      '"the first word is X and the second word is Y"',
      (w) => w.map((x, i) => `the ${SPELLED_ORDINALS[i]} word is ${x}`).join(' and '),
    ],
    ['"my 1st word is X and my 2nd word is Y"', (w) => w.map((x, i) => `my ${nth(i)} word is ${x}`).join(' and ')],
    [
      '"1st word is X, and the 2nd word is Y"',
      (w) => w.map((x, i) => `${i === 0 ? '' : 'the '}${nth(i)} word is ${x}`).join(', and '),
    ],
    [
      '"the first one is X and the second one is Y"',
      (w) => w.map((x, i) => `the ${SPELLED_ORDINALS[i]} one is ${x}`).join(' and '),
    ],
  ];
  for (const bits of [128, 256] as const)
    for (const [name, make] of CASES)
      test(`blocked, ${bits === 128 ? 12 : 24} words: ${name}`, () => {
        const phrases = [...fixedPhrases(25, bits, [], undefined, 'and-')];
        if (bits === 128) phrases.push(phraseWith('ocean', 2, 9), ...HOLDS_LABELS);
        for (const words of phrases) expectBlocked(make(words), words);
      });
  test('ordinary text joined with "and" is left alone', () => {
    for (const p of [
      'The first thing is the price and the second thing is the speed and the third thing is the design of the app.',
      'My first word was hello and my second word was thanks and my third word was a question about the price.',
      'The first step is to open the menu and the second step is to pick a theme and the third step is to save it.',
    ]) {
      expect(containsPhrase(p)).toBe(false);
      expect(looksLikeSecret(p)).toBe(false);
    }
  });
});

describe('a different filler between each word, fixed phrases (round-3 review of b-Aware row 353)', () => {
  const fill = ['zq', 'xv', 'kj', 'qx', 'vv', 'jz', 'xq', 'zx', 'qj', 'kx', 'jx', 'vq'];
  test('30 fixed phrases', () => {
    for (const phrase of fixedPhrases(30, 128))
      expectBlocked(phrase.map((w, i) => `${w} ${fill[i]}`).join(' '), phrase);
  });
  test('a phrase that repeats a word', () => {
    const phrase = phraseWith('ocean', 2, 9);
    expect(new Set(phrase).size).toBe(11);
    expectBlocked(phrase.map((w, i) => `${w} ${fill[i]}`).join(' '), phrase);
  });
});

describe('invisible characters inside words (round-3 review of b-Aware row 353)', () => {
  const INVISIBLE: Array<[string, string]> = [
    ['zero-width space', String.fromCharCode(0x200b)],
    ['zero-width non-joiner', String.fromCharCode(0x200c)],
    ['zero-width joiner', String.fromCharCode(0x200d)],
    ['word joiner', String.fromCharCode(0x2060)],
    ['byte order mark', String.fromCharCode(0xfeff)],
    ['soft hyphen', String.fromCharCode(0x00ad)],
  ];
  for (const [name, ch] of INVISIBLE)
    test(`${name} inside every word`, () => {
      for (const words of [...fixedPhrases(5, 128), ...fixedPhrases(2, 256)]) {
        const text = words.map((w) => `${w.slice(0, 2)}${ch}${w.slice(2)}`).join(' ');
        expectBlocked(text, words);
        // Nothing of the words is left, split or whole.
        expect(redactSecrets(text)).toBe('[recovery words hidden]');
      }
    });
  test('between every letter, and joining the words', () => {
    const words = fixedPhrases(1, 128)[0];
    expectBlocked(words.map((w) => w.split('').join(String.fromCharCode(0x200b))).join(' '), words);
    // "qqq"/"zzz", not list words: the guard takes neighbouring list words ("before") into the hidden stretch.
    expect(hidePhrases(`qqq ${words.join(`${String.fromCharCode(0x00ad)} `)} zzz`)).toBe(
      'qqq [recovery words hidden] zzz',
    );
  });
});

describe('invisible letters and look-alike letters inside words (round-4 review of b-Aware row 353)', () => {
  // Hangul fillers are letters (Lo), not format characters, so they stayed in the word: 200 of 200 got past Ask b.
  const FILLERS: Array<[string, string]> = [
    ['Hangul filler', String.fromCharCode(0x3164)],
    ['Hangul choseong filler', String.fromCharCode(0x115f)],
    ['Hangul jungseong filler', String.fromCharCode(0x1160)],
    ['halfwidth Hangul filler', String.fromCharCode(0xffa0)],
  ];
  for (const [name, ch] of FILLERS)
    test(`${name} inside every word`, () => {
      for (const words of [...fixedPhrases(5, 128), ...fixedPhrases(2, 256)]) {
        const text = words.map((w) => `${w.slice(0, 2)}${ch}${w.slice(2)}`).join(' ');
        expectBlocked(text, words);
        expect(redactSecrets(text)).toBe('[recovery words hidden]');
      }
    });
  test('words joined only by an invisible character', () => {
    for (const ch of [String.fromCharCode(0x200b), String.fromCharCode(0x3164)]) {
      const words = fixedPhrases(1, 128)[0];
      expect(looksLikeSecret(words.join(ch))).toBe(true);
      expect(redactSecrets(words.join(ch))).toBe('[recovery words hidden]');
    }
  });
  // Cyrillic letters that look like Latin ones: a e o p c y x i j s h, and capitals A B E K M H O P C T Y X.
  const LOOK: Record<string, string> = {
    a: '\u0430',
    e: '\u0435',
    o: '\u043e',
    p: '\u0440',
    c: '\u0441',
    y: '\u0443',
    x: '\u0445',
    i: '\u0456',
    s: '\u0455',
  };
  const swap = (w: string) => w.replace(/[aeopcyxis]/g, (c) => LOOK[c]);
  test('Cyrillic look-alike letters in every word', () => {
    for (const words of [...fixedPhrases(5, 128), ...fixedPhrases(2, 256)]) {
      const text = words.map(swap).join(' ');
      expect(looksLikeSecret(text)).toBe(true);
      expect(redactSecrets(text)).toBe('[recovery words hidden]');
      const upper = words.map((w) => swap(w).toUpperCase()).join(' ');
      expect(looksLikeSecret(upper)).toBe(true);
      expect(redactSecrets(upper)).toBe('[recovery words hidden]');
    }
  });
  test('one look-alike letter in every word, numbered', () => {
    for (const words of fixedPhrases(5, 128)) {
      const text = words.map((w, i) => `${i + 1}. ${w.replace(/[aeopcyxis]/, (c) => LOOK[c])}`).join(' ');
      expect(looksLikeSecret(text)).toBe(true);
      expect(redactSecrets(text)).toBe('[recovery words hidden]');
    }
  });
  test('Russian, Ukrainian and Korean prose is left alone', () => {
    for (const p of [
      'Я вчера пытался отправить деньги другу, но приложение сказало, что перевод не прошёл. Скажите, пожалуйста, что случилось и как это исправить?',
      'Сохраните слова восстановления на бумаге и никому их не показывайте. Если вы потеряете телефон, эти слова вернут ваш кошелёк.',
      'Привіт! Після оновлення сторінка балансу порожня, а кнопка назад нічого не робить. Що мені робити з цим гаманцем?',
      '어제 친구에게 돈을 보내려고 했는데 앱에서 거래가 실패했다고 합니다. 무슨 일이 있었는지 알려주세요.',
    ]) {
      expect(containsPhrase(p)).toBe(false);
      expect(looksLikeSecret(p)).toBe(false);
    }
  });
});

describe('a 24-word phrase that repeats two words (round-3 review of b-Aware row 353)', () => {
  // About 1 random 24-word phrase in 125 repeats two words. With one filler between the words, 2a allowed one repeat and
  // stopped at the second, leaving the end of the phrase readable (a random Japanese test failed this way, 22 Nov 2026).
  const twoRepeats = (lang: 'english' | 'japanese') => {
    const list = bip39.wordlists[lang];
    const base = fixedPhrases(1, 256, [], list, `two-repeats-${lang}`)[0].map((w) =>
      list.findIndex((x) => x.normalize('NFC') === w),
    ); // the list is NFKD
    base[15] = base[3];
    base[20] = base[7];
    const bits = base
      .slice(0, 23)
      .map((i) => i.toString(2).padStart(11, '0'))
      .join('')
      .concat(base[23].toString(2).padStart(11, '0').slice(0, 3));
    const hex = bits.replace(/[01]{4}/g, (n) => parseInt(n, 2).toString(16));
    return bip39.entropyToMnemonic(hex, list).normalize('NFC').split(/\s+/);
  };
  for (const lang of ['english', 'japanese'] as const)
    test(`${lang}, a filler between every word`, () => {
      const words = twoRepeats(lang);
      expect(words.length).toBe(24);
      expect(new Set(words).size).toBe(22);
      expectBlocked(words.join(' zz '), words);
      expectBlocked(words.map((w, i) => `${w} q${String.fromCharCode(97 + i)}x`).join(' '), words);
    });
});
