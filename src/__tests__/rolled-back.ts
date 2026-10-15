/**
 * Which calls a test's spies saw inside transactions an encoder rolled back.
 */

import { Encoder } from '../packer';

/**
 * Runs `run` and tells, for a mock's invocation order, whether that call
 * was made inside a transaction an encoder rolled back: a try `decide`
 * did not keep, whose writes never reach the message.
 */
export const rolledBack = (run: () => void): ((order: number) => boolean) => {
  const mark = jest.spyOn(Encoder.prototype, 'mark');
  const rollback = jest.spyOn(Encoder.prototype, 'rollback');
  try {
    run();
    const opened = new Map<unknown, number>();
    mark.mock.results.forEach(({ value }, i) =>
      opened.set(value, mark.mock.invocationCallOrder[i])
    );
    const spans = rollback.mock.calls.map(([m], i) => [
      opened.get(m) as number,
      rollback.mock.invocationCallOrder[i],
    ]);
    return (order) => spans.some(([from, to]) => order > from && order < to);
  } finally {
    mark.mockRestore();
    rollback.mockRestore();
  }
};
