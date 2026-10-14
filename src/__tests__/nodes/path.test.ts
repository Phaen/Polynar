/**
 * `noted`: a note after an error's message, which a path added later goes in front of.
 */

import { atPath, noted } from '../../nodes/path';

describe('noted', () => {
  it('appends the note to the message', () => {
    expect((noted(new Error('boom'), 'at step 1') as Error).message).toBe('boom, at step 1');
  });

  it('keeps the note behind a path added before and after', () => {
    const error = noted(atPath(new Error('boom'), 'n'), 'note') as Error;
    expect(error.message).toBe('n: boom, note');
    expect((atPath(error, 'outer') as Error).message).toBe('outer.n: boom, note');
  });

  it('returns a non-Error as it is', () => {
    expect(noted('boom', 'note')).toBe('boom');
  });

  it('puts the new message on the first line of the stack', () => {
    const error = noted(new Error('boom'), 'at step 1') as Error;
    expect(error.stack?.startsWith('Error: boom, at step 1')).toBe(true);
  });
});
