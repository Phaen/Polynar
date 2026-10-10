/**
 * `p.bool()`: true or false.
 */

import { p } from '../../index';

describe('Schema bool', () => {
  it('lists weights true first', () => {
    const likelyTrue = p.array(p.bool().weights([99, 1])).length(64);
    const trues = Array<boolean>(64).fill(true);
    const falses = Array<boolean>(64).fill(false);
    expect(likelyTrue.encode(trues).length).toBeLessThan(likelyTrue.encode(falses).length);
  });
});
