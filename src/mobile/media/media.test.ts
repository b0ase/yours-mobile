import { describe, expect, test } from 'bun:test';
import type { WalletOutput } from '@bsv/sdk';
import { documentLabel, isMediaOutput, isWriterDocument, kindOf } from './media';

const out = (tags: string[]) => ({ outpoint: 'x.0', satoshis: 1, spendable: true, tags }) as WalletOutput;

describe('media filters', () => {
  test('kindOf groups by MIME family', () => {
    expect(kindOf('audio/mpeg')).toBe('music');
    expect(kindOf('video/mp4')).toBe('video');
    expect(kindOf('image/png')).toBe('images');
    expect(kindOf('text/html')).toBe('other');
    expect(kindOf(undefined)).toBe('other');
  });
  test('fungible tokens are not media', () => {
    expect(isMediaOutput(out(['type:application/bsv-20']))).toBe(false);
    expect(isMediaOutput(out(['type:image/png']))).toBe(true);
  });
  test('documents: PDF, text, Markdown, HTML, RTF, Office; not JSON or media', () => {
    expect(documentLabel('application/pdf')).toBe('PDF');
    expect(documentLabel('text/plain; charset=utf-8')).toBe('TXT');
    expect(documentLabel('TEXT/MARKDOWN')).toBe('MD');
    expect(documentLabel('text/html')).toBe('HTML');
    expect(documentLabel('application/rtf')).toBe('RTF');
    expect(documentLabel('application/msword')).toBe('DOC');
    expect(documentLabel('application/vnd.openxmlformats-officedocument.wordprocessingml.document')).toBe('DOCX');
    expect(documentLabel('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')).toBe('XLSX');
    expect(documentLabel('application/vnd.openxmlformats-officedocument.presentationml.presentation')).toBe('PPTX');
    for (const t of ['application/json', 'image/png', 'audio/mpeg', 'application/octet-stream', '', null, undefined])
      expect(documentLabel(t)).toBeNull();
  });
  test('bWriter documents by MAP app', () => {
    expect(isWriterDocument({ app: 'bitcoin-writer', type: 'chainproof' })).toBe(true);
    expect(isWriterDocument({ app: 'BitcoinWriter' })).toBe(true);
    expect(isWriterDocument({ app: 'treechat' })).toBe(false);
    expect(isWriterDocument(undefined)).toBe(false);
  });
});
