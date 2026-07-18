/**
 * Schema bool node (`p.bool()`) — true/false values.
 */

import { p } from '../../index';
import { trip } from '../support';

describe('Schema bool', () => {
  it('bool round-trips both values', () => {
    expect(trip(p.bool(), true)).toBe(true);
    expect(trip(p.bool(), false)).toBe(false);
  });
});
