/**
 * The journal: records only under an open mark, takes changes back newest
 * first, nests marks, and refuses marks out of order.
 */

import { Journal, type Undoable } from '../packer';

/** An object that logs the ops it is asked to take back. */
class Logged implements Undoable {
  readonly undone: [number, number, number][] = [];

  undo(op: number, a: number, b: number): void {
    this.undone.push([op, a, b]);
  }
}

describe('Journal', () => {
  it('records nothing with no mark open', () => {
    const journal = new Journal();
    const items = [1, 2, 3];
    expect(journal.active).toBe(false);
    journal.truncate(items, 0);
    const mark = journal.mark();
    expect(journal.active).toBe(true);
    journal.rollback(mark);
    expect(items).toEqual([1, 2, 3]);
    expect(journal.active).toBe(false);
  });

  it('takes back every kind of record, newest first', () => {
    const journal = new Journal();
    const order: string[] = [];
    const items = [1];
    const state = { n: 1, on: false };
    const map = new Map([['a', 1]]);
    const own = new Logged();
    const mark = journal.mark();

    items.push(2, 3);
    journal.truncate(items, 1);
    journal.set(state, 'n', state.n);
    state.n = 5;
    journal.set(items, 0, items[0]);
    items[0] = 9;
    journal.flag(state, 'on', state.on);
    state.on = true;
    journal.flag(state, 'on', state.on);
    state.on = false;
    const cell = [4, 2];
    journal.pair(cell, cell[0], cell[1]);
    cell[0] = 7;
    cell[1] = 1;
    map.set('b', 2);
    journal.drop(map, 'b');
    journal.call(() => order.push('call'));
    journal.own(own, 7, 1, 2);
    journal.own(own, 8);

    journal.rollback(mark);
    expect(items).toEqual([1]);
    expect(state).toEqual({ n: 1, on: false });
    expect(cell).toEqual([4, 2]);
    expect([...map]).toEqual([['a', 1]]);
    expect(order).toEqual(['call']);
    expect(own.undone).toEqual([
      [8, 0, 0],
      [7, 1, 2],
    ]);
  });

  it('grows past its first arrays', () => {
    const journal = new Journal();
    const state = { n: 0 };
    const mark = journal.mark();
    for (let i = 0; i < 1000; i++) {
      journal.set(state, 'n', state.n);
      state.n = i + 1;
    }
    journal.rollback(mark);
    expect(state.n).toBe(0);
  });

  it('nests marks: an inner rollback leaves the outer changes, an outer one takes all', () => {
    const journal = new Journal();
    const state = { n: 0 };
    const set = (n: number): void => {
      journal.set(state, 'n', state.n);
      state.n = n;
    };
    const outer = journal.mark();
    set(1);
    const inner = journal.mark();
    expect([outer, inner]).toEqual([0, 1]);
    set(2);
    journal.rollback(inner);
    expect(state.n).toBe(1);
    expect(journal.active).toBe(true);
    const kept = journal.mark();
    set(3);
    journal.release(kept);
    expect(state.n).toBe(3);
    journal.rollback(outer);
    expect(state.n).toBe(0);
  });

  it('closes the marks inside one rolled back', () => {
    const journal = new Journal();
    const state = { n: 0 };
    const outer = journal.mark();
    journal.mark();
    journal.set(state, 'n', 0);
    state.n = 4;
    journal.rollback(outer);
    expect(state.n).toBe(0);
    expect(journal.active).toBe(false);
  });

  it('keeps nothing once the last mark is released', () => {
    const journal = new Journal();
    const state = { n: 0 };
    const mark = journal.mark();
    journal.set(state, 'n', 0);
    state.n = 2;
    journal.release(mark);
    expect(journal.active).toBe(false);
    const next = journal.mark();
    journal.rollback(next);
    expect(state.n).toBe(2);
  });

  it('refuses a mark that is not open, and releasing one with marks inside it', () => {
    const journal = new Journal();
    expect(() => journal.rollback(0)).toThrow(new RangeError('Mark 0 is not open'));
    const outer = journal.mark();
    journal.mark();
    expect(() => journal.release(outer)).toThrow(new RangeError('Mark 0 has marks open inside it'));
    for (const bad of [-1, 2, 0.5]) {
      expect(() => journal.release(bad)).toThrow(new RangeError(`Mark ${bad} is not open`));
    }
  });
});
