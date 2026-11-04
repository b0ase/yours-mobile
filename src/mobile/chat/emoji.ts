/**
 * Emoji for the chat composer (owner, 4 Nov 2026: "the chatbar in chats in all versions need to support emojis").
 * PURE. A small local set drawn by the device's own emoji font: nothing is fetched, no image sprites, no picker
 * library. Emoji up to Unicode 13 only, so older phones draw every one.
 */

export type EmojiGroup = { id: string; label: string; icon: string; emoji: readonly string[] };

const g = (id: string, label: string, list: string): EmojiGroup => {
  const emoji = list.split(/\s+/).filter(Boolean);
  return { id, label, icon: emoji[0], emoji };
};

export const EMOJI_GROUPS: readonly EmojiGroup[] = [
  g(
    'smileys',
    'Smileys',
    `😀 😃 😄 😁 😆 😅 🤣 😂 🙂 🙃 😉 😊 😇 🥰 😍 🤩 😘 😗 😚 😙 😋 😛 😜 🤪 😝 🤑 🤗 🤭 🤫 🤔 🤐 🤨 😐 😑 😶
     😏 😒 🙄 😬 😌 😔 😪 🤤 😴 😷 🤒 🤕 🤢 🤮 🥵 🥶 🥴 😵 🤯 🤠 🥳 😎 🤓 🧐 😕 😟 🙁 😮 😯 😲 😳 🥺 😦 😧
     😨 😰 😥 😢 😭 😱 😖 😣 😞 😓 😩 😫 🥱 😤 😡 😠 🤬 😈 👿 💀 ☠️ 💩 🤡 👹 👺 👻 👽 👾 🤖 😺 😸 😹 😻 😼 😽 🙀 😿 😾`,
  ),
  g(
    'people',
    'Gestures',
    `👍 👎 👌 🤌 🤏 ✌️ 🤞 🤟 🤘 🤙 👈 👉 👆 👇 ☝️ ✋ 🤚 🖐️ 🖖 👋 🤝 👏 🙌 👐 🤲 🙏 ✍️ 💅 🤳 💪 🦾 🧠 👀 👁️
     👅 👄 💋 👶 🧒 👦 👧 🧑 👱 👨 🧔 👩 🧓 👴 👵 🙍 🙎 🙅 🙆 💁 🙋 🧏 🙇 🤦 🤷 👮 🕵️ 💂 👷 🤴 👸 👳 🧕 🤵 👰
     🤰 🤱 👼 🎅 🤶 🦸 🦹 🧙 🧚 🧛 🧜 🧝 🧞 🧟 💆 💇 🚶 🧍 🧎 🏃 💃 🕺 👯 🧖 🧗 🏇 ⛷️ 🏂 🏌️ 🏄 🚣 🏊 ⛹️ 🏋️ 🚴`,
  ),
  g(
    'hearts',
    'Hearts',
    `❤️ 🧡 💛 💚 💙 💜 🖤 🤍 🤎 💔 ❣️ 💕 💞 💓 💗 💖 💘 💝 💟 ♥️ 💌 💯 💢 💥 💫 💦 💨 🕳️ 💬 🗨️ 🗯️ 💭 💤 ✨ 🔥 ⭐ 🌟 ⚡`,
  ),
  g(
    'animals',
    'Animals',
    `🐶 🐱 🐭 🐹 🐰 🦊 🐻 🐼 🐨 🐯 🦁 🐮 🐷 🐸 🐵 🙈 🙉 🙊 🐒 🐔 🐧 🐦 🐤 🦆 🦅 🦉 🦇 🐺 🐗 🐴 🦄 🐝 🐛 🦋 🐌 🐞
     🐜 🦗 🕷️ 🦂 🐢 🐍 🦎 🦖 🦕 🐙 🦑 🦐 🦞 🦀 🐡 🐠 🐟 🐬 🐳 🐋 🦈 🐊 🐅 🐆 🦓 🦍 🐘 🦛 🦏 🐪 🐫 🦒 🦘 🐃 🐂
     🐄 🐎 🐖 🐏 🐑 🦙 🐐 🦌 🐕 🐩 🐈 🐓 🦃 🦚 🦜 🦢 🕊️ 🐇 🦝 🦨 🦡 🦦 🦥 🐁 🐀 🐿️ 🦔 🌵 🎄 🌲 🌳 🌴 🌱 🌿 ☘️ 🍀
     🍁 🍂 🍃 🍄 🌷 🌹 🥀 🌺 🌸 🌼 🌻 🌞 🌝 🌛 🌜 🌚 🌕 🌙 🌎 🪐 💐 🌈 ☀️ ⛅ ☁️ 🌧️ ⛈️ 🌩️ ❄️ ☃️ ⛄ 🌊`,
  ),
  g(
    'food',
    'Food',
    `🍏 🍎 🍐 🍊 🍋 🍌 🍉 🍇 🍓 🍈 🍒 🍑 🥭 🍍 🥥 🥝 🍅 🍆 🥑 🥦 🥬 🥒 🌶️ 🌽 🥕 🧄 🧅 🥔 🍠 🥐 🥯 🍞 🥖 🥨 🧀 🥚
     🍳 🧈 🥞 🧇 🥓 🥩 🍗 🍖 🌭 🍔 🍟 🍕 🥪 🥙 🧆 🌮 🌯 🥗 🥘 🍝 🍜 🍲 🍛 🍣 🍱 🥟 🍤 🍙 🍚 🍘 🍥 🥠 🍢 🍡 🍧 🍨
     🍦 🥧 🧁 🍰 🎂 🍮 🍭 🍬 🍫 🍿 🍩 🍪 🌰 🥜 🍯 🥛 ☕ 🍵 🧃 🥤 🍶 🍺 🍻 🥂 🍷 🥃 🍸 🍹 🧉 🍾 🧊 🥄 🍴 🍽️`,
  ),
  g(
    'activity',
    'Activity',
    `⚽ 🏀 🏈 ⚾ 🥎 🎾 🏐 🏉 🥏 🎱 🏓 🏸 🏒 🏑 🥍 🏏 🥅 ⛳ 🏹 🎣 🥊 🥋 🎽 🛹 🛷 ⛸️ 🥌 🎿 🏆 🥇 🥈 🥉 🏅 🎖️
     🏵️ 🎗️ 🎫 🎟️ 🎪 🤹 🎭 🎨 🎬 🎤 🎧 🎼 🎹 🥁 🎷 🎺 🎸 🪕 🎻 🎲 ♟️ 🎯 🎳 🎮 🕹️ 🎰 🧩 🎉 🎊 🎈 🎁 🎀 🪅`,
  ),
  g(
    'travel',
    'Travel',
    `🚗 🚕 🚙 🚌 🚎 🏎️ 🚓 🚑 🚒 🚐 🚚 🚛 🚜 🛴 🚲 🛵 🏍️ 🚨 🚔 🚍 🚘 🚖 🚡 🚠 🚟 🚃 🚋 🚞 🚝 🚄 🚅 🚈 🚂 🚆
     🚇 🚊 🚉 ✈️ 🛫 🛬 💺 🚁 🚀 🛸 🛰️ ⛵ 🚤 🛥️ 🛳️ ⛴️ 🚢 ⚓ 🗽 🗼 🏰 🏯 🏟️ 🎡 🎢 🎠 ⛲ 🏖️ 🏝️ 🏜️ 🌋 ⛰️ 🏔️ 🗻
     🏕️ 🏠 🏡 🏘️ 🏗️ 🏭 🏢 🏬 🏣 🏥 🏦 🏨 🏪 🏫 🏩 💒 🏛️ ⛪ 🕌 🕍 🕋 ⛩️ 🗾 🎑 🏞️ 🌅 🌄 🌠 🎇 🎆 🌇 🌆 🏙️ 🌃 🌌 🌉 🌁`,
  ),
  g(
    'objects',
    'Objects',
    `⌚ 📱 💻 ⌨️ 🖥️ 🖨️ 🖱️ 💽 💾 💿 📀 📷 📸 📹 🎥 📞 ☎️ 📺 📻 🎙️ ⏰ ⌛ ⏳ 📡 🔋 🔌 💡 🔦 🕯️ 💸 💵 💴 💶
     💷 💰 💳 💎 ⚖️ 🔧 🔨 ⚒️ 🛠️ ⛏️ 🔩 ⚙️ 🧱 ⛓️ 🧲 🔫 💣 🧨 🔪 🗡️ ⚔️ 🛡️ 🔮 📿 🧿 💈 ⚗️ 🔭 🔬 💊 💉 🧬 🦠 🧪
     🌡️ 🧹 🧺 🧻 🚽 🛁 🔑 🗝️ 🚪 🛋️ 🛏️ 🧸 🖼️ 🛍️ 🛒 🎁 ✉️ 📩 📨 📧 📦 📮 📜 📃 📄 📑 📊 📈 📉 📆 📅 🗓️ 📇 🗃️ 🗳️
     🗄️ 📋 📁 📂 🗂️ 🗞️ 📰 📓 📔 📒 📕 📗 📘 📙 📚 📖 🔖 🔗 📎 🖇️ 📐 📏 📌 📍 ✂️ 🖊️ 🖋️ ✒️ 🖌️ 🖍️ 📝 ✏️ 🔍 🔎 🔏
     🔐 🔒 🔓`,
  ),
  g(
    'symbols',
    'Symbols',
    `✅ ☑️ ✔️ ❌ ❎ ➕ ➖ ➗ ✖️ ♾️ ‼️ ⁉️ ❓ ❔ ❕ ❗ 〰️ 💱 💲 ⚠️ 🚸 ⛔ 🚫 🚳 🚭 🚯 🚱 🚷 📵 🔞 ☢️ ☣️ ⬆️ ↗️ ➡️
     ↘️ ⬇️ ↙️ ⬅️ ↖️ ↕️ ↔️ ↩️ ↪️ ⤴️ ⤵️ 🔃 🔄 🔙 🔚 🔛 🔜 🔝 🛐 ⚛️ ☮️ ☯️ ♈ ♉ ♊ ♋ ♌ ♍ ♎ ♏ ♐ ♑ ♒ ♓ ⛎ 🔀 🔁 🔂
     ▶️ ⏩ ⏭️ ⏯️ ◀️ ⏪ ⏮️ 🔼 ⏫ 🔽 ⏬ ⏸️ ⏹️ ⏺️ 🎦 🔅 🔆 📶 📳 📴 ♀️ ♂️ ⚧️ ♻️ ⚜️ 🔱 📛 🔰 ⭕ 🛑 🆗 🆒 🆕 🆓 🆙 🆘
     🔴 🟠 🟡 🟢 🔵 🟣 ⚫ ⚪ 🟤 🔺 🔻 🔸 🔹 🔶 🔷 🔳 🔲 ▪️ ▫️ ◾ ◽ ◼️ ◻️ 🟥 🟧 🟨 🟩 🟦 🟪 ⬛ ⬜ 🟫 🏁 🚩 🎌 🏴 🏳️ 🏳️‍🌈`,
  ),
];

/** Every emoji in the set, once. */
export const ALL_EMOJI: readonly string[] = [...new Set(EMOJI_GROUPS.flatMap((x) => x.emoji))];

/**
 * Put `insert` into `value` at the caret (replacing a selection) and say where the caret goes next. A caret the
 * browser could not report (null, or past the end after the draft changed) means the end of the text.
 */
export function insertAtCursor(
  value: string,
  selStart: number | null | undefined,
  selEnd: number | null | undefined,
  insert: string,
): { value: string; caret: number } {
  const len = value.length;
  const clamp = (n: number | null | undefined, fallback: number) =>
    typeof n === 'number' && Number.isFinite(n) ? Math.max(0, Math.min(len, Math.floor(n))) : fallback;
  const start = clamp(selStart, len);
  const end = Math.max(start, clamp(selEnd, start));
  return { value: value.slice(0, start) + insert + value.slice(end), caret: start + insert.length };
}

// Pictographic emoji plus what joins and dresses them (variation selector, ZWJ, skin tones, keycaps, flags, tags).
const EMOJI_ONLY =
  /^(?:\p{Extended_Pictographic}|\p{Regional_Indicator}|\p{Emoji_Modifier}|️|‍|⃣|[\u{E0020}-\u{E007F}]|\s)+$/u;

/**
 * A message that is only 1–3 emoji (no words, no digits) is drawn large, as WhatsApp and iMessage do. Counted in
 * grapheme clusters, so 👍🏽 or a family emoji is one.
 */
export function bigEmojiCount(text: string | null | undefined): number {
  const t = (text ?? '').trim();
  if (!t || t.length > 40 || !EMOJI_ONLY.test(t)) return 0;
  let n = 0;
  if (typeof Intl !== 'undefined' && 'Segmenter' in Intl) {
    const seg = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
    for (const s of seg.segment(t.replace(/\s+/g, ''))) if (s.segment) n++;
  } else {
    n = [...t.replace(/\s+/g, '').matchAll(/\p{Extended_Pictographic}/gu)].length;
  }
  return n >= 1 && n <= 3 ? n : 0;
}

// ── Recently used (this device only; a convenience, so it may be missing) ─────────────────────

const RECENT_KEY = 'bwallet.chat.recentEmoji';
const RECENT_MAX = 24;

export function readRecentEmoji(): string[] {
  try {
    const raw = globalThis.localStorage?.getItem(RECENT_KEY);
    const list = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(list) ? list.filter((e): e is string => typeof e === 'string').slice(0, RECENT_MAX) : [];
  } catch {
    return [];
  }
}

/** Move `emoji` to the front of the recent list. */
export function rememberEmoji(emoji: string, current: readonly string[] = readRecentEmoji()): string[] {
  const next = [emoji, ...current.filter((e) => e !== emoji)].slice(0, RECENT_MAX);
  try {
    globalThis.localStorage?.setItem(RECENT_KEY, JSON.stringify(next));
  } catch {
    /* private mode / no storage: this session only */
  }
  return next;
}
