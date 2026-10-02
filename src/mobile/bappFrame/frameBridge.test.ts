import { describe, expect, test } from 'bun:test';
import {
  frameAllowlist,
  frameOriginFor,
  framingAllowed,
  isAllowedFrameOrigin,
  parseXdmRequest,
  toXdmResponse,
} from './frameBridge';

const allow = frameAllowlist([
  'https://bitcoin-writer.com/',
  'https://www.bitcoin-mint.com/mint',
  'http://insecure.example',
  'not a url',
]);

describe('allowlist', () => {
  test('keeps exact https origins only', () => {
    expect([...allow].sort()).toEqual(['https://bitcoin-writer.com', 'https://www.bitcoin-mint.com']);
  });
  test('origin checks are exact', () => {
    expect(isAllowedFrameOrigin('https://bitcoin-writer.com', allow)).toBe(true);
    expect(isAllowedFrameOrigin('https://evil.bitcoin-writer.com', allow)).toBe(false);
    expect(isAllowedFrameOrigin('https://bitcoin-writer.com.evil.io', allow)).toBe(false);
    expect(isAllowedFrameOrigin('http://bitcoin-writer.com', allow)).toBe(false);
    expect(isAllowedFrameOrigin('https://bitcoin-writer.com/path', allow)).toBe(false);
    expect(isAllowedFrameOrigin('https://bitcoin-writer.com:8443', allow)).toBe(false);
    expect(isAllowedFrameOrigin('null', allow)).toBe(false);
    expect(isAllowedFrameOrigin('', allow)).toBe(false);
  });
  test('frameOriginFor maps URLs to allowlisted origins', () => {
    expect(frameOriginFor('https://www.bitcoin-mint.com/other?x=1', allow)).toBe('https://www.bitcoin-mint.com');
    expect(frameOriginFor('https://bitcoin-mint.com/mint', allow)).toBeNull();
    expect(frameOriginFor('javascript:alert(1)', allow)).toBeNull();
  });
});

describe('XDM request validation', () => {
  const ok = { type: 'CWI', isInvocation: true, id: 'abc', call: 'getPublicKey', args: { identityKey: true } };
  test('accepts a well-formed BRC-100 call', () => {
    expect(parseXdmRequest(ok)).toEqual({ id: 'abc', call: 'getPublicKey', args: { identityKey: true } });
    expect(parseXdmRequest({ ...ok, args: undefined })?.args).toEqual({});
  });
  test('rejects malformed or foreign messages', () => {
    expect(parseXdmRequest(null)).toBeNull();
    expect(parseXdmRequest('CWI')).toBeNull();
    expect(parseXdmRequest([ok])).toBeNull();
    expect(parseXdmRequest({ ...ok, type: 'other' })).toBeNull();
    expect(parseXdmRequest({ ...ok, isInvocation: false })).toBeNull();
    expect(parseXdmRequest({ ...ok, id: '' })).toBeNull();
    expect(parseXdmRequest({ ...ok, id: 'x'.repeat(200) })).toBeNull();
    expect(parseXdmRequest({ ...ok, id: 5 })).toBeNull();
    expect(parseXdmRequest({ ...ok, call: 'MASTER_BACKUP' })).toBeNull();
    expect(parseXdmRequest({ ...ok, call: 'getBalance' })).toBeNull();
    expect(parseXdmRequest({ ...ok, args: [1] })).toBeNull();
    expect(parseXdmRequest({ ...ok, args: 'x' })).toBeNull();
  });
  test('maps wallet replies to XDM responses', () => {
    expect(toXdmResponse('1', { success: true, data: { publicKey: '02ab' } })).toEqual({
      type: 'CWI',
      isInvocation: false,
      id: '1',
      status: 'success',
      result: { publicKey: '02ab' },
    });
    expect(toXdmResponse('2', { success: false, error: 'User denied' })).toMatchObject({
      status: 'error',
      description: 'User denied',
      code: 1,
    });
    expect(toXdmResponse('3', undefined)).toMatchObject({ status: 'error', description: 'Request failed' });
  });
});

describe('framing headers', () => {
  const ios = 'capacitor://localhost';
  const android = 'https://localhost';
  test('no headers → allowed', () => {
    expect(framingAllowed({}, ios)).toBe(true);
  });
  test('X-Frame-Options refuses', () => {
    expect(framingAllowed({ 'X-Frame-Options': 'DENY' }, ios)).toBe(false);
    expect(framingAllowed({ 'x-frame-options': 'SAMEORIGIN' }, android)).toBe(false);
  });
  test('frame-ancestors overrides X-Frame-Options', () => {
    const csp = "default-src 'self'; frame-ancestors 'self' capacitor://localhost https://localhost";
    const h = { 'content-security-policy': csp, 'x-frame-options': 'SAMEORIGIN' };
    expect(framingAllowed(h, ios)).toBe(true);
    expect(framingAllowed(h, android)).toBe(true);
    expect(framingAllowed({ 'content-security-policy': "frame-ancestors 'self'" }, ios)).toBe(false);
    expect(framingAllowed({ 'content-security-policy': "frame-ancestors 'none'" }, android)).toBe(false);
  });
  test('wildcards, scheme-only and ports', () => {
    expect(framingAllowed({ 'content-security-policy': 'frame-ancestors *' }, android)).toBe(true);
    expect(framingAllowed({ 'content-security-policy': 'frame-ancestors capacitor:' }, ios)).toBe(true);
    expect(framingAllowed({ 'content-security-policy': 'frame-ancestors https://*.vercel.app' }, android)).toBe(false);
    expect(framingAllowed({ 'content-security-policy': 'frame-ancestors https://localhost:*' }, android)).toBe(true);
    expect(framingAllowed({ 'content-security-policy': 'frame-ancestors https://localhost:8443' }, android)).toBe(
      false,
    );
  });
});
