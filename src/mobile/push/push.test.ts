import { describe, expect, test } from 'bun:test';
import {
  deviceBody,
  fromServerPrefs,
  normHhmm,
  pushAppFor,
  pushEnvFor,
  roomNotifyFor,
  routeFromData,
  routeFromQuery,
  routeToQuery,
  toServerPrefs,
  webNotification,
  DEFAULT_UI_PREFS,
} from './logic';

describe('channel → app / env', () => {
  test('store channels are bWallet, everything else bWalletX', () => {
    expect(pushAppFor('ios-store', false)).toBe('bwallet');
    expect(pushAppFor('android-play', false)).toBe('bwallet');
    expect(pushAppFor('ios-private', false)).toBe('bwalletx');
    expect(pushAppFor('android-direct', false)).toBe('bwalletx');
    expect(pushAppFor('dev', false)).toBe('bwalletx');
    expect(pushAppFor('dev', true)).toBe('bwallet'); // VITE_STORE_BUILD=1 local build
  });
  test('only iOS can be sandbox', () => {
    expect(pushEnvFor('ios', 'sandbox')).toBe('sandbox');
    expect(pushEnvFor('ios', null)).toBe('production');
    expect(pushEnvFor('android', 'sandbox')).toBe('production');
    expect(pushEnvFor('web', 'sandbox')).toBe('production');
  });
  test('device bodies match the server schema', () => {
    expect(
      deviceBody({ platform: 'ios', channel: 'ios-private', store: false, env: 'sandbox', token: 'abcdefgh' }),
    ).toEqual({
      platform: 'ios',
      app: 'bwalletx',
      env: 'sandbox',
      bundleId: 'com.bitcoincorp.bwallet.private',
      token: 'abcdefgh',
    });
    expect(
      deviceBody({
        platform: 'ios',
        channel: 'dev',
        store: false,
        bundleId: 'com.bitcoincorp.bwallet',
        token: 't'.repeat(8),
      }),
    ).toMatchObject({ app: 'bwalletx', env: 'production', bundleId: 'com.bitcoincorp.bwallet' });
    expect(
      deviceBody({
        platform: 'android',
        channel: 'android-play',
        store: true,
        token: 'fcm-token',
        bundleId: 'com.bitcoincorp.bwallet',
      }),
    ).toEqual({
      platform: 'android',
      app: 'bwallet',
      bundleId: 'com.bitcoincorp.bwallet',
      token: 'fcm-token',
    });
    const sub = { endpoint: 'https://fcm.googleapis.com/x', keys: { p256dh: 'p', auth: 'a' } };
    const web = deviceBody({ platform: 'web', channel: 'dev', store: false, subscription: sub, token: 'ignored' });
    expect(web).toEqual({ platform: 'web', app: 'bwalletx', webPushSubscription: sub });
    expect(deviceBody({ platform: 'extension', channel: 'dev', store: false, subscription: sub }).platform).toBe(
      'extension',
    );
  });
});

describe('payload → route', () => {
  test('room message and mention open the room', () => {
    expect(
      routeFromData({ kind: 'room_message', ticker: 'BOASE', room: 'BOASE', url: '/room/BOASE', dm: false }),
    ).toEqual({
      segment: 'rooms',
      ticker: 'BOASE',
    });
    expect(routeFromData({ kind: 'room_mention', ticker: '$npg' })).toEqual({ segment: 'rooms', ticker: 'NPG' });
  });
  test('DMs open the DMs segment, with FCM string flags too', () => {
    expect(routeFromData({ kind: 'room_message', ticker: 'DM-AB12', dm: true })).toEqual({
      segment: 'dms',
      ticker: 'DM-AB12',
    });
    expect(routeFromData({ kind: 'room_message', ticker: 'DM-AB12', dm: 'true' })?.segment).toBe('dms');
    expect(routeFromData({ kind: 'room_message', ticker: 'X', dm: 'false' })?.segment).toBe('rooms');
  });
  test('falls back to room, then url; ignores calls and junk', () => {
    expect(routeFromData({ room: 'abc' })).toEqual({ segment: 'rooms', ticker: 'ABC' });
    expect(routeFromData({ kind: 'b_answer', url: '/room/HELP?x=1' })).toEqual({ segment: 'rooms', ticker: 'HELP' });
    expect(routeFromData({ kind: 'call', ticker: 'ABC' })).toBeNull();
    expect(routeFromData({ kind: 'room_message', ticker: 'bad ticker!' })).toBeNull();
    expect(routeFromData(undefined)).toBeNull();
    expect(routeFromData({})).toBeNull();
  });
  test('web click query round-trips', () => {
    const r = { segment: 'dms' as const, ticker: 'DM-1' };
    expect(routeFromQuery(`?${routeToQuery(r)}`)).toEqual(r);
    expect(routeFromQuery('?push=rooms:%24boase')).toEqual({ segment: 'rooms', ticker: 'BOASE' });
    expect(routeFromQuery('?push=evil:ABC')).toBeNull();
    expect(routeFromQuery('')).toBeNull();
  });
  test('web notification from the server payload', () => {
    const n = webNotification(
      JSON.stringify({ title: '$alice', body: 'hi', tag: 'ABC', data: { ticker: 'ABC' }, urgent: false }),
    );
    expect(n).toEqual({
      title: '$alice',
      options: { body: 'hi', tag: 'ABC', data: { ticker: 'ABC' }, requireInteraction: false },
    });
    expect(webNotification('not json').title).toBe('bWalletX');
    expect(webNotification(null).options.body).toBe('');
  });
});

describe('prefs mapping', () => {
  test('server defaults → previews off, quiet off', () => {
    expect(fromServerPrefs({ previews: false, quietFrom: null, quietTo: null, tz: null, categories: {} })).toEqual(
      DEFAULT_UI_PREFS,
    );
    expect(fromServerPrefs(null)).toEqual(DEFAULT_UI_PREFS);
  });
  test('quiet hours round-trip with the device time zone', () => {
    const ui = fromServerPrefs({ previews: true, quietFrom: '23:30', quietTo: '7:00', tz: 'Europe/London' });
    expect(ui).toMatchObject({ previews: true, quiet: true, quietFrom: '23:30', quietTo: '07:00' });
    expect(toServerPrefs(ui, 'Asia/Tokyo')).toEqual({
      previews: true,
      quietFrom: '23:30',
      quietTo: '07:00',
      tz: 'Asia/Tokyo',
      categories: {},
    });
  });
  test('quiet off (or equal / bad times) sends nulls', () => {
    expect(toServerPrefs({ ...DEFAULT_UI_PREFS, quiet: false }, 'UTC')).toMatchObject({
      quietFrom: null,
      quietTo: null,
      tz: null,
    });
    expect(
      toServerPrefs({ ...DEFAULT_UI_PREFS, quiet: true, quietFrom: '22:00', quietTo: '22:00' }, 'UTC').quietFrom,
    ).toBeNull();
    expect(toServerPrefs({ ...DEFAULT_UI_PREFS, quiet: true, quietFrom: '25:00' }, 'UTC').quietFrom).toBeNull();
    expect(fromServerPrefs({ previews: false, quietFrom: '08:00', quietTo: '08:00' }).quiet).toBe(false);
  });
  test('normHhmm', () => {
    expect(normHhmm('7:05')).toBe('07:05');
    expect(normHhmm('24:00')).toBeNull();
    expect(normHhmm('7:5')).toBeNull();
    expect(normHhmm(5)).toBeNull();
  });
  test('room bell: chosen value, else DM all / group mentions', () => {
    expect(roomNotifyFor({ ABC: 'off' }, '$abc')).toBe('off');
    expect(roomNotifyFor({}, 'ABC')).toBe('mentions');
    expect(roomNotifyFor(null, 'DM-1', true)).toBe('all');
    expect(roomNotifyFor({ ABC: 'bogus' as never }, 'ABC')).toBe('mentions');
  });
});

describe('sign-in alert taps', () => {
  test('a sign_in push opens Recent sign-ins', () => {
    const r = routeFromData({ kind: 'sign_in', url: '/settings/chat/sign-ins', device: 'ios-app' });
    expect(r).toEqual({ segment: 'signins', ticker: '' });
    expect(routeFromQuery(`?${routeToQuery(r!)}`)).toEqual({ segment: 'signins', ticker: '' });
  });
});
