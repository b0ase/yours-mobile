import { KeyDeriver, PrivateKey, Random, Signature, Utils, type WalletInterface } from '@bsv/sdk';

/**
 * Signed notes: a short text (an IOU, a promise, a receipt) signed with the wallet's identity key, as one JSON file
 * anyone can check at bwalletx.com/verify-note. Pure apart from the wallet call.
 *
 * Signed bytes: UTF-8 of `bwalletx signed note v1\n<signer identity key>\n<date ISO>\n<text>`.
 * Signature: BRC-77 byte layout (version, signer, 0, keyID, DER sig), made under the wallet-only protocol
 * [2,'bwalletx signed note'] to anyone, so no outside app can get a note signed in the user's name.
 */
export const NOTE_PROTOCOL: [2, string] = [2, 'bwalletx signed note'];
export const NOTE_TYPE = 'bwalletx-signed-note' as const;
export const NOTE_SCHEME = 'bwx-note' as const;
export const NOTE_MAX_CHARS = 4000;
const VERSION = [0x42, 0x42, 0x33, 0x01];

export interface SignedNote {
  type: typeof NOTE_TYPE;
  v: 1;
  text: string;
  signer: string;
  date: string;
  scheme: typeof NOTE_SCHEME;
  signature: string;
}

export const noteMessage = (signer: string, date: string, text: string) =>
  `bwalletx signed note v1\n${signer}\n${date}\n${text}`;

export const signNote = async (
  wallet: Pick<WalletInterface, 'getPublicKey' | 'createSignature'>,
  text: string,
  nowMs = Date.now(),
): Promise<SignedNote> => {
  const body = text.trim();
  if (!body) throw new Error('Write the note first.');
  if (body.length > NOTE_MAX_CHARS) throw new Error(`Keep it under ${NOTE_MAX_CHARS} characters.`);
  const { publicKey: signer } = await wallet.getPublicKey({ identityKey: true });
  const date = new Date(nowMs).toISOString();
  const keyID = Random(32);
  const { signature } = await wallet.createSignature({
    data: Utils.toArray(noteMessage(signer, date, body), 'utf8'),
    protocolID: NOTE_PROTOCOL,
    keyID: Utils.toBase64(keyID),
    counterparty: 'anyone',
  });
  const bytes = [...VERSION, ...Utils.toArray(signer, 'hex'), 0, ...keyID, ...signature];
  return { type: NOTE_TYPE, v: 1, text: body, signer, date, scheme: NOTE_SCHEME, signature: Utils.toHex(bytes) };
};

/** True when the note's signature is by note.signer over exactly this text and date. Same check as /verify-note. */
export const verifyNote = (note: SignedNote): boolean => {
  try {
    if (note?.type !== NOTE_TYPE || note.scheme !== NOTE_SCHEME) return false;
    const bytes = Utils.toArray(String(note.signature), 'hex');
    const signer = Utils.toHex(bytes.slice(4, 37));
    if (signer !== String(note.signer).toLowerCase() || bytes[37] !== 0) return false;
    const keyID = Utils.toBase64(bytes.slice(38, 70));
    const pub = new KeyDeriver(new PrivateKey(1)).derivePublicKey(NOTE_PROTOCOL, keyID, signer, false);
    return pub.verify(
      Utils.toArray(noteMessage(note.signer, note.date, note.text), 'utf8'),
      Signature.fromDER(bytes.slice(70)),
    );
  } catch {
    return false;
  }
};

export const noteFileName = (note: SignedNote) => `bwalletx-note-${note.date.slice(0, 10)}.json`;
