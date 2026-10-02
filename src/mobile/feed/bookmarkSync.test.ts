import { describe, expect, test } from 'bun:test';
import { queueOp, unsynced } from './bookmarkSync';
import type { FeedPost } from './post';

const post = (txid: string) => ({ txid }) as FeedPost;

describe('bookmark sync', () => {
  test('a later tap on the same post replaces the earlier one', () => {
    let ops = queueOp([], { op: 'add', post: post('a') });
    ops = queueOp(ops, { op: 'add', post: post('b') });
    ops = queueOp(ops, { op: 'del', txid: 'a' });
    expect(ops).toEqual([
      { op: 'add', post: post('b') },
      { op: 'del', txid: 'a' },
    ]);
  });
  test('first sync uploads only what the server lacks', () => {
    expect(unsynced([post('a'), post('b')], [post('b')]).map((p) => p.txid)).toEqual(['a']);
  });
});
