import { describe, expect, test } from 'bun:test';
import { switchBackHint } from './doneHint';

describe('PairSheet done hint', () => {
  test('iOS says Safari, others "your browser", with the host', () => {
    expect(switchBackHint('www.bchatx.com', true)).toContain('switch back to Safari to carry on at www.bchatx.com');
    expect(switchBackHint('www.bchatx.com', false)).toContain(
      'switch back to your browser to carry on at www.bchatx.com',
    );
  });
});
