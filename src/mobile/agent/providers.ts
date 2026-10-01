/**
 * "Own API key" mode: the device calls the AI provider directly with the user's key. The key is
 * read from the device's secure storage (keyStore.ts) right before the call, goes ONLY in the
 * request to that provider's own host, and is never sent to bCorp, never logged.
 *
 * Adding a provider = one entry in PROVIDERS. Pure: builds requests and reads replies (tested in
 * providers.test.ts); `callProvider` is the only thing that touches the network.
 */
import type { AgentMessage } from './agent';

export type ProviderId = 'anthropic' | 'openai' | 'openrouter';
export type ChatTurn = { role: 'user' | 'assistant'; text: string };
export type ProviderRequest = { url: string; init: { method: 'POST'; headers: Record<string, string>; body: string } };

export type Provider = {
  id: ProviderId;
  label: string;
  /** Exact origin every request goes to; the key never goes anywhere else. */
  origin: string;
  models: { id: string; label: string }[];
  defaultModel: string;
  /** Any model id is allowed (typed in Settings); `models` are just suggestions. */
  freeModel: boolean;
  keyHint: string;
  keyUrl: string;
  build: (key: string, model: string, system: string, turns: ChatTurn[], maxTokens: number) => ProviderRequest;
  parse: (data: unknown) => string;
};

export const MAX_OUTPUT_TOKENS = 1024;

const obj = (v: unknown) => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {});

/** OpenAI-style chat completions (OpenAI and OpenRouter). */
const chatCompletions =
  (url: string, extraHeaders: Record<string, string>, tokenField: 'max_tokens' | 'max_completion_tokens') =>
  (key: string, model: string, system: string, turns: ChatTurn[], maxTokens: number): ProviderRequest => ({
    url,
    init: {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${key}`, ...extraHeaders },
      body: JSON.stringify({
        model,
        [tokenField]: maxTokens,
        messages: [{ role: 'system', content: system }, ...turns.map((t) => ({ role: t.role, content: t.text }))],
      }),
    },
  });

const parseChatCompletions = (data: unknown): string => {
  const choice = (obj(data).choices as unknown[] | undefined)?.[0];
  const content = obj(obj(choice).message).content;
  return typeof content === 'string' ? content.trim() : '';
};

export const PROVIDERS: Record<ProviderId, Provider> = {
  anthropic: {
    id: 'anthropic',
    label: 'Anthropic',
    origin: 'https://api.anthropic.com',
    models: [
      { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5 (fast)' },
      { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5' },
    ],
    defaultModel: 'claude-haiku-4-5-20251001',
    freeModel: true,
    keyHint: 'sk-ant-…',
    keyUrl: 'https://console.anthropic.com/settings/keys',
    build: (key, model, system, turns, maxTokens) => ({
      url: 'https://api.anthropic.com/v1/messages',
      init: {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': key,
          'anthropic-version': '2023-06-01',
          // Required for calls from a browser / WebView (CORS). The key is the user's own.
          'anthropic-dangerous-direct-browser-access': 'true',
        },
        body: JSON.stringify({
          model,
          max_tokens: maxTokens,
          system,
          messages: turns.map((t) => ({ role: t.role, content: t.text })),
        }),
      },
    }),
    parse: (data) => {
      const blocks = obj(data).content;
      if (!Array.isArray(blocks)) return '';
      return blocks
        .map((b) => (obj(b).type === 'text' && typeof obj(b).text === 'string' ? (obj(b).text as string) : ''))
        .join('')
        .trim();
    },
  },
  openai: {
    id: 'openai',
    label: 'OpenAI',
    origin: 'https://api.openai.com',
    models: [
      { id: 'gpt-5-mini', label: 'GPT-5 mini (fast)' },
      { id: 'gpt-5', label: 'GPT-5' },
    ],
    defaultModel: 'gpt-5-mini',
    freeModel: true,
    keyHint: 'sk-…',
    keyUrl: 'https://platform.openai.com/api-keys',
    build: chatCompletions('https://api.openai.com/v1/chat/completions', {}, 'max_completion_tokens'),
    parse: parseChatCompletions,
  },
  openrouter: {
    id: 'openrouter',
    label: 'OpenRouter',
    origin: 'https://openrouter.ai',
    models: [
      { id: 'anthropic/claude-haiku-4.5', label: 'Claude Haiku 4.5' },
      { id: 'openai/gpt-5-mini', label: 'GPT-5 mini' },
    ],
    defaultModel: 'anthropic/claude-haiku-4.5',
    freeModel: true,
    keyHint: 'sk-or-…',
    keyUrl: 'https://openrouter.ai/keys',
    build: chatCompletions(
      'https://openrouter.ai/api/v1/chat/completions',
      { 'X-Title': 'bWallet', 'HTTP-Referer': 'https://bwallet.space' },
      'max_tokens',
    ),
    parse: parseChatCompletions,
  },
};

export const PROVIDER_IDS = Object.keys(PROVIDERS) as ProviderId[];
export const isProviderId = (v: unknown): v is ProviderId => typeof v === 'string' && v in PROVIDERS;

/** A model id the user typed: trimmed, sane characters only, else the provider default. */
export const cleanModel = (provider: ProviderId, model: unknown): string => {
  const m = typeof model === 'string' ? model.trim() : '';
  return /^[\w.:/@-]{1,120}$/.test(m) ? m : PROVIDERS[provider].defaultModel;
};

/** Provider APIs need user/assistant alternation starting with the user; merge and trim to fit. */
export const toTurns = (messages: AgentMessage[]): ChatTurn[] => {
  const out: ChatTurn[] = [];
  for (const m of messages) {
    const text = m.text.trim();
    if (!text || (m.role !== 'user' && m.role !== 'assistant')) continue;
    const last = out[out.length - 1];
    if (last && last.role === m.role) last.text += `\n\n${text}`;
    else out.push({ role: m.role, text });
  }
  while (out.length && out[0].role !== 'user') out.shift();
  return out;
};

export const buildProviderRequest = (
  provider: ProviderId,
  key: string,
  model: string,
  system: string,
  messages: AgentMessage[],
  maxTokens = MAX_OUTPUT_TOKENS,
): ProviderRequest => {
  const p = PROVIDERS[provider];
  const req = p.build(key, cleanModel(provider, model), system, toTurns(messages), maxTokens);
  // Belt and braces: the key may only ever travel to the provider's own origin.
  if (new URL(req.url).origin !== p.origin) throw new Error('Refusing to send the key to another host.');
  return req;
};

/** Error text from a provider reply, with anything key-shaped removed (some APIs echo part of the key). */
export const providerError = (status: number, data: unknown, key: string): string => {
  const e = obj(data).error;
  const raw = typeof e === 'string' ? e : typeof obj(e).message === 'string' ? (obj(e).message as string) : '';
  let msg = raw || `The provider answered ${status}.`;
  if (key) msg = msg.split(key).join('•••');
  msg = msg.replace(/\b(sk|rk)-[\w-]{6,}/g, '•••');
  if (status === 401 || status === 403)
    return `The provider rejected the key (${status}). Check it in Settings › b agent.`;
  if (status === 429) return 'The provider is rate limiting or your credit ran out (429).';
  return msg.slice(0, 300);
};

/** Calls the provider directly from the device. Never logs the request (it carries the key). */
export const callProvider = async (
  provider: ProviderId,
  key: string,
  model: string,
  system: string,
  messages: AgentMessage[],
  maxTokens = MAX_OUTPUT_TOKENS,
  fetchImpl: typeof fetch = fetch,
): Promise<string> => {
  const { url, init } = buildProviderRequest(provider, key, model, system, messages, maxTokens);
  let res: Response;
  try {
    res = await fetchImpl(url, { ...init, credentials: 'omit', referrerPolicy: 'no-referrer' });
  } catch {
    throw new Error(`Could not reach ${PROVIDERS[provider].label}. Check your connection.`);
  }
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(providerError(res.status, data, key));
  return PROVIDERS[provider].parse(data) || 'No reply.';
};
