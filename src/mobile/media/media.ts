import type { WalletOutput } from '@bsv/sdk';
import { getTagValue } from '../../utils/format';

export type MediaKind = 'music' | 'video' | 'images' | 'other';

/** Fungible token inscriptions and wallet tags are not media (they live in Wallet). */
export const isMediaOutput = (o: WalletOutput) => {
  const type = getTagValue(o.tags, 'type');
  return type !== 'application/bsv-20' && type !== 'panda/tag' && type !== 'yours/tag';
};

export const kindOf = (contentType: string | undefined): MediaKind => {
  const t = (contentType ?? '').toLowerCase();
  if (t.startsWith('audio/')) return 'music';
  if (t.startsWith('video/')) return 'video';
  if (t.startsWith('image/')) return 'images';
  return 'other';
};

/**
 * Document inscriptions (Market › NFTs › Documents; Wallet › NFTs can use it later): PDF, plain text,
 * Markdown, HTML, RTF and Word / Excel / PowerPoint (legacy + OOXML). JSON is left out on purpose: on
 * chain it is overwhelmingly protocol data (token mints, MAP payloads), not documents people read.
 * Returns a short type badge ('PDF', 'DOCX', ...) or null when it isn't a document.
 */
const DOC_TYPES: Record<string, string> = {
  'application/pdf': 'PDF',
  'text/plain': 'TXT',
  'text/markdown': 'MD',
  'text/x-markdown': 'MD',
  'text/html': 'HTML',
  'application/rtf': 'RTF',
  'text/rtf': 'RTF',
  'application/msword': 'DOC',
  'application/vnd.ms-excel': 'XLS',
  'application/vnd.ms-powerpoint': 'PPT',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'DOCX',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'XLSX',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'PPTX',
};
export const documentLabel = (contentType: string | null | undefined): string | null =>
  DOC_TYPES[(contentType ?? '').split(';')[0].trim().toLowerCase()] ?? null;

/** bWriter (Bitcoin Writer) documents carry MAP app "bitcoin-writer" (chainproof) or "BitcoinWriter". */
export const isWriterDocument = (map: Record<string, unknown> | null | undefined) => {
  const app = String(map?.app ?? '').toLowerCase();
  return app === 'bitcoin-writer' || app === 'bitcoinwriter';
};
