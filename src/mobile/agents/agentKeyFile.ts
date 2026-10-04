/**
 * Agent account › Export for the CLI (SMART-WALLET-SPEC.md, standalone mode). Only agent accounts can be
 * exported, so a server never holds the main wallet. The file is encrypted with a passphrase the user
 * picks; the bWalletX CLI (`bwalletx key import`) decrypts it with the same scheme:
 *   PBKDF2-SHA256 (310k iterations, 16-byte salt) → AES-256-GCM (12-byte iv, tag appended, as WebCrypto does).
 */
export const AGENT_KEY_FORMAT = 'bwalletx.agentkey/1';
export const KEYFILE_ITER = 310_000;
export const MIN_PASSPHRASE = 10;

export type AgentKeySecrets = { payPk: string; ordPk: string; identityPk: string };
export type AgentKeyFile = {
  format: typeof AGENT_KEY_FORMAT;
  name: string;
  identityAddress: string;
  enc: { kdf: 'pbkdf2-sha256'; iter: number; salt: string; iv: string; alg: 'aes-256-gcm'; data: string };
};

const b64 = (b: Uint8Array) => btoa(String.fromCharCode(...b));
const unb64 = (s: string): Uint8Array<ArrayBuffer> => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

const aesKey = async (passphrase: string, salt: Uint8Array<ArrayBuffer>, iter: number) => {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: iter }, base, { name: 'AES-GCM', length: 256 }, false, [
    'encrypt',
    'decrypt',
  ]);
};

export const encryptAgentKeyFile = async (
  meta: { name: string; identityAddress: string },
  secrets: AgentKeySecrets,
  passphrase: string,
  iter = KEYFILE_ITER,
): Promise<AgentKeyFile> => {
  if (passphrase.length < MIN_PASSPHRASE) throw new Error(`Use a passphrase of at least ${MIN_PASSPHRASE} characters.`);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await aesKey(passphrase, salt, iter);
  const data = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(JSON.stringify(secrets))));
  return {
    format: AGENT_KEY_FORMAT,
    name: meta.name.slice(0, 60),
    identityAddress: meta.identityAddress,
    enc: { kdf: 'pbkdf2-sha256', iter, salt: b64(salt), iv: b64(iv), alg: 'aes-256-gcm', data: b64(data) },
  };
};

export const decryptAgentKeyFile = async (file: AgentKeyFile, passphrase: string): Promise<AgentKeySecrets> => {
  if (file.format !== AGENT_KEY_FORMAT) throw new Error('Not a bWalletX agent key file');
  const key = await aesKey(passphrase, unb64(file.enc.salt), file.enc.iter);
  try {
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(file.enc.iv) }, key, unb64(file.enc.data));
    return JSON.parse(new TextDecoder().decode(plain)) as AgentKeySecrets;
  } catch {
    throw new Error('Wrong passphrase');
  }
};
