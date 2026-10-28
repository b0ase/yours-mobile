import { describe, expect, test } from 'bun:test';
import { docHashFor, offerSignLink, parseSignLink, phoneSignUrl, takeSignLink } from './signLink';
import { signDocUrl } from './pendingDoc';

const ID = '04ea9a26-6e55-4b19-8c16-ee76b8d7397a';
const H = 'ab'.repeat(32);

describe('parseSignLink', () => {
  test('the /r/ universal link, the current /room/ QR and the app scheme', () => {
    const want = { ticker: 'BCORPBOARD', docId: ID, hash: H };
    expect(parseSignLink(`https://www.bchatx.com/r/BCORPBOARD?sign=${ID}&h=${H}`)).toEqual(want);
    expect(parseSignLink(`https://www.bchatx.com/room/BCORPBOARD?sign=${ID}&h=${H.toUpperCase()}`)).toEqual(want);
    expect(parseSignLink(`https://chat.bwalletx.com/r/bcorpboard?sign=${ID}&h=${H}`)).toEqual(want);
    expect(parseSignLink(`bwalletx://sign/BCORPBOARD?sign=${ID}&h=${H}`)).toEqual(want);
  });
  test('refuses other hosts, paths, short hashes and junk', () => {
    expect(parseSignLink(`https://evil.example/r/BCORPBOARD?sign=${ID}&h=${H}`)).toBeNull();
    expect(parseSignLink(`https://www.bchatx.com/r/BCORPBOARD?sign=${ID}&h=abcd`)).toBeNull();
    expect(parseSignLink(`https://www.bchatx.com/r/BCORPBOARD`)).toBeNull();
    expect(parseSignLink(`https://www.bchatx.com/x/BCORPBOARD?sign=${ID}&h=${H}`)).toBeNull();
    expect(parseSignLink(`https://www.bchatx.com/r/BC/extra?sign=${ID}&h=${H}`)).toBeNull();
    expect(parseSignLink(`http://www.bchatx.com/r/BCORPBOARD?sign=${ID}&h=${H}`)).toBeNull();
    expect(parseSignLink(`https://u:p@www.bchatx.com/r/BCORPBOARD?sign=${ID}&h=${H}`)).toBeNull();
    expect(parseSignLink(`bwalletx://room/BCORPBOARD?sign=${ID}&h=${H}`)).toBeNull();
    expect(parseSignLink(`https://www.bchatx.com/r/BCORPBOARD?sign=a%20b&h=${H}`)).toBeNull();
    expect(parseSignLink('not a url')).toBeNull();
    expect(parseSignLink(null)).toBeNull();
  });
});

describe('sign link flow', () => {
  test('offer keeps the hash for the banner and the page is the hash-checked one', () => {
    expect(offerSignLink(`https://www.bchatx.com/r/BCORPBOARD?sign=${ID}&h=${H}`)).toBe(true);
    const s = takeSignLink();
    expect(s).toEqual({ ticker: 'BCORPBOARD', docId: ID, hash: H });
    expect(takeSignLink()).toBeNull();
    expect(phoneSignUrl(s!)).toBe(`https://www.bchatx.com/room/BCORPBOARD?sign=${ID}&h=${H}`);
    expect(docHashFor('$bcorpboard', ID)).toBe(H);
    expect(signDocUrl('BCORPBOARD', ID, docHashFor('BCORPBOARD', ID))).toBe(phoneSignUrl(s!));
    expect(offerSignLink('https://www.bchatx.com/r/BCORPBOARD')).toBe(false);
  });
  test('without a hash the banner keeps the plain ?doc= page', () => {
    expect(signDocUrl('BCORPBOARD', ID, null)).toBe(`https://www.bchatx.com/room/BCORPBOARD?doc=${ID}`);
    expect(signDocUrl('BCORPBOARD', ID, 'xyz')).toBe(`https://www.bchatx.com/room/BCORPBOARD?doc=${ID}`);
  });
});
