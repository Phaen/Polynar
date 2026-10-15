/**
 * The journal's completeness, over random schemas: a message written with
 * trial writes rolled back before and between its values, nested trials and
 * trials that throw half way included, comes out byte for byte as the
 * message written plainly. Any change a write makes that the journal does
 * not take back shows up as a different message. A trial kept with
 * `commit` is a real write, so it is written plainly too. The cases come
 * from ./random-schemas under fixed seeds; FUZZ scales the iteration count.
 */

import * as lib from '../index';
import type { PNode } from '../index';
import { mulberry32 } from './support';
import { rand, randInt, randomCase, useRng } from './random-schemas';

const SCALE = Math.max(0, Number(process.env.FUZZ ?? 1));
const runs = (n: number): number => Math.max(1, Math.round(n * SCALE));

type Node = PNode<unknown>;

/** One step of a message: a value written for real, or a trial taken back. */
type Step =
  | { kind: 'write'; value: unknown; kept: boolean }
  | { kind: 'trial'; value: unknown; inner: Step[] };

/**
 * Up to `n` random trials, each a value (of the schema, or of another one,
 * which may throw half way), with trials nested in them down to `depth`
 * levels, and values kept inside them by a nested commit.
 */
const trials = (gen: () => unknown, depth: number, n = randInt(0, 2)): Step[] => {
  const steps: Step[] = [];
  for (let i = 0; i < n; i++) {
    const value = rand() < 0.85 ? gen() : randomCase(1).gen();
    const inner = depth > 0 ? trials(gen, depth - 1, randInt(0, 2)) : [];
    if (depth > 0 && rand() < 0.3) {
      inner.push({ kind: 'write', value: gen(), kept: true });
    }
    steps.push({ kind: 'trial', value, inner });
  }
  return steps;
};

/** Runs `steps` on `enc`: a trial writes its value and its inner steps, then rolls all back. */
const run = (node: Node, enc: lib.Encoder, steps: readonly Step[]): void => {
  for (const step of steps) {
    if (step.kind === 'write') {
      if (step.kept) {
        const mark = enc.mark();
        node._write(enc, step.value);
        enc.commit(mark);
      } else {
        node._write(enc, step.value);
      }
      continue;
    }
    const mark = enc.mark();
    try {
      node._write(enc, step.value);
      run(node, enc, step.inner);
    } catch {
      // A value the schema cannot write throws part way through its write.
    }
    expect(enc.bitsSince(mark)).toBeGreaterThanOrEqual(0);
    enc.rollback(mark);
  }
};

/** The values `steps` writes for real, outside any trial. */
const written = (steps: readonly Step[]): unknown[] =>
  steps.flatMap((step) => (step.kind === 'write' ? [step.value] : []));

/** A schema built for this test, with a value generator. */
interface Heavy {
  node: Node;
  gen: () => unknown;
}

/** Text over a few letters, long enough to halve contexts, cells and counts. */
const letters = (min: number, max: number): string =>
  Array.from({ length: randInt(min, max) }, () => 'abcab '[randInt(0, 5)]).join('');

/** A JSON-like record of a few keys, nested now and then. */
const record = (depth: number): Record<string, unknown> => ({
  id: randInt(0, 40),
  name: letters(0, 12),
  ok: rand() < 0.5,
  ...(depth > 0 && rand() < 0.4 ? { sub: [record(depth - 1), record(depth - 1)] } : {}),
});

/**
 * Schemas whose values run long enough to reach the rarer changes: halving
 * contexts, escape cells, learned counts and blends, the live tables built
 * from pending values, repeats, the mode's trials and recall.
 */
const HEAVY: readonly (() => Heavy)[] = [
  () => ({ node: lib.p.string().adaptive() as Node, gen: () => letters(200, 3000) }),
  () => ({
    node: lib.p.binary().adaptive({ window: 16 }) as Node,
    gen: () => Uint8Array.from({ length: randInt(100, 1500) }, () => randInt(0, 3) * 60),
  }),
  () => ({
    node: lib.p.array(lib.p.string().adaptive({ window: 8 }).recall()) as Node,
    gen: () => Array.from({ length: randInt(1, 40) }, () => letters(0, 30)),
  }),
  () => ({
    node: lib.p.array(lib.p.int().min(0).max(9).adaptive({ window: 4 })) as Node,
    gen: () => Array.from({ length: randInt(1, 80) }, () => randInt(0, 3) * randInt(0, 3)),
  }),
  () => ({
    node: lib.p.array(lib.p.int().adaptive()) as Node,
    gen: () => Array.from({ length: randInt(1, 60) }, () => randInt(-3, 3) * 1000 + randInt(0, 5)),
  }),
  () => ({
    node: lib.p.any().adaptive({ window: 2 }) as Node,
    gen: () => Array.from({ length: randInt(1, 30) }, () => record(2)),
  }),
  () => ({
    node: lib.p.string().repeats() as Node,
    gen: () => letters(10, 400),
  }),
];

describe('Transactions', () => {
  it('leave a message byte-identical to the plain write, whatever is tried and rolled back', () => {
    useRng(mulberry32(0x7a11));
    for (let i = 0; i < runs(400); i++) {
      const c = randomCase(2);
      const node = c.build(lib) as Node;
      const steps: Step[] = [];
      for (let k = randInt(1, 4); k > 0; k--) {
        steps.push(...trials(c.gen, 2));
        steps.push({ kind: 'write', value: c.gen(), kept: rand() < 0.3 });
      }
      steps.push(...trials(c.gen, 2));

      const plain = new lib.Encoder();
      for (const value of written(steps)) {
        node._write(plain, value);
      }
      const tried = new lib.Encoder({ checkDecisions: true });
      run(node, tried, steps);
      expect(tried.output()).toEqual(plain.output());
    }
  });

  it('leave long adaptive messages byte-identical too', () => {
    useRng(mulberry32(0x7a12));
    for (let i = 0; i < runs(40); i++) {
      const { node, gen } = HEAVY[i % HEAVY.length]();
      const steps: Step[] = [];
      for (let k = randInt(1, 3); k > 0; k--) {
        steps.push(...trials(gen, 1));
        steps.push({ kind: 'write', value: gen(), kept: rand() < 0.3 });
      }
      const plain = new lib.Encoder();
      for (const value of written(steps)) {
        node._write(plain, value);
      }
      const tried = new lib.Encoder({ checkDecisions: true });
      run(node, tried, steps);
      expect(tried.output()).toEqual(plain.output());
    }
  });
});

/** Writes a symbol of `bits` bits, a uniform slot of 2^bits states. */
const spend = (enc: lib.Encoder, bits: number): void => enc.compose(0, 2 ** bits);

describe('Encoder transactions', () => {
  it('price what was written since a mark, and take it back or keep it', () => {
    const enc = new lib.Encoder();
    enc.compose(1, 2);
    const mark = enc.mark();
    enc.compose(3, 8);
    enc.composeWeighted(0, 1, 4);
    expect(enc.bitsSince(mark)).toBe(5);
    enc.rollback(mark);
    expect(enc.events().totals).toEqual([2]);
    const kept = enc.mark();
    enc.compose(3, 8);
    enc.commit(kept);
    const plain = new lib.Encoder();
    plain.compose(1, 2);
    plain.compose(3, 8);
    expect(enc.output()).toEqual(plain.output());
  });

  it('price a selector and alternatives in coding 2, or the last of fewer', () => {
    const enc = new lib.Encoder();
    const three = {};
    const two = {};
    const mark = enc.mark();
    enc.composeSelector(three, [
      [0, 2, 4],
      [2, 1, 4],
      [3, 1, 4],
    ]);
    enc.composeAlternatives(three, [
      [0, 1, 2],
      [0, 1, 4],
      [0, 1, 8],
    ]);
    enc.composeSelector(two, [
      [0, 1, 2],
      [1, 1, 2],
    ]);
    enc.composeAlternatives(two, [
      [0, 1, 2],
      [0, 1, 16],
    ]);
    // Selectors of 2 and 1 bits, alternatives of 3 and 4.
    expect(enc.bitsSince(mark)).toBe(10);
    enc.rollback(mark);
    // The groups opened in the transaction went with it.
    expect(() => enc.composeAlternatives(three, [])).toThrow(
      new TypeError('Group has no selector')
    );
    enc.composeSelector(three, [[0, 4, 4]]);
  });

  it('refuse to output with a transaction open', () => {
    const enc = new lib.Encoder();
    enc.mark();
    expect(() => enc.output()).toThrow(new TypeError('Encoder has a transaction open'));
  });
});

describe('Encoder.decide', () => {
  /** A decide on a fresh encoder where candidate c spends `costs[c]` bits, and the candidates written. */
  const spent = (
    costs: readonly number[],
    priority: readonly number[],
    order: readonly number[]
  ): { choice: number; calls: number[]; enc: lib.Encoder } => {
    const enc = new lib.Encoder();
    const calls: number[] = [];
    const choice = enc.decide(priority, order, (c) => {
      calls.push(c);
      spend(enc, costs[c]);
    });
    return { choice, calls, enc };
  };

  it('writes the cheapest candidate, a tie to the first in priority', () => {
    const { choice, enc } = spent([4, 2, 3], [0, 1, 2], [0, 1, 2]);
    expect(choice).toBe(1);
    const plain = new lib.Encoder();
    spend(plain, 2);
    expect(enc.output()).toEqual(plain.output());
    expect(spent([3, 3], [1, 0], [0, 1]).choice).toBe(1);
    expect(spent([3, 3], [0, 1], [1, 0]).choice).toBe(0);
  });

  it('keeps the last try when it wins, and writes another winner again', () => {
    expect(spent([4, 2], [0, 1], [0, 1]).calls).toEqual([0, 1]);
    expect(spent([2, 4], [0, 1], [0, 1]).calls).toEqual([0, 1, 0]);
  });

  it('aborts a try once it passes the best so far, or reaches it losing the tie', () => {
    const enc = new lib.Encoder();
    let steps = 0;
    const choice = enc.decide([0, 1], [0, 1], (c) => {
      if (c === 0) {
        spend(enc, 4);
        return;
      }
      for (let i = 0; i < 100; i++) {
        steps++;
        spend(enc, 1);
      }
    });
    expect(choice).toBe(0);
    // Four bits tie the budget, which candidate 1 loses.
    expect(steps).toBe(4);
    // Winning the tie, a try runs on at the budget and wins.
    expect(spent([4, 4], [1, 0], [0, 1]).choice).toBe(1);
  });

  it('passes over a candidate that throws, and throws the first in priority when all do', () => {
    const enc = new lib.Encoder();
    const choice = enc.decide([0, 1], [0, 1], (c) => {
      spend(enc, 1);
      if (c === 0) {
        throw new RangeError('no');
      }
    });
    expect(choice).toBe(1);
    expect(() =>
      new lib.Encoder().decide([1, 0], [0, 1], (c) => {
        throw new RangeError(`no ${c}`);
      })
    ).toThrow(new RangeError('no 1'));
  });

  it('writes a winner again taking the choices and notes its try made', () => {
    const enc = new lib.Encoder();
    const inner: number[] = [];
    const notes: number[] = [];
    const choice = enc.decide([0, 1], [0, 1], (c) => {
      spend(enc, c === 0 ? 1 : 6);
      enc.note(() => {
        notes.push(c);
        return [c, 7];
      });
      enc.decide([0, 1], [0, 1], (d) => {
        inner.push(d);
        spend(enc, d === 0 ? 3 : 1);
      });
    });
    expect(choice).toBe(0);
    // Candidate 0 tries both inner candidates; candidate 1 passes the
    // budget at once; candidate 0 is written again with its inner choice.
    expect(inner).toEqual([0, 1, 1]);
    expect(notes).toEqual([0]);
  });

  it('stops tries inside a try that passes its budget', () => {
    const enc = new lib.Encoder();
    const inner: number[] = [];
    const choice = enc.decide([0, 1], [0, 1], (c) => {
      if (c === 0) {
        spend(enc, 4);
        return;
      }
      enc.decide([0, 1], [0, 1], (d) => {
        inner.push(d);
        spend(enc, 10);
      });
    });
    expect(choice).toBe(0);
    expect(inner).toEqual([0, 1]);
    // An inner candidate within the outer budget wins over one it stopped.
    const cheap = new lib.Encoder();
    const won = cheap.decide([0, 1], [0, 1], (c) => {
      if (c === 0) {
        spend(cheap, 4);
        return;
      }
      cheap.decide([0, 1], [0, 1], (d) => spend(cheap, d === 0 ? 20 : 1));
    });
    expect(won).toBe(1);
  });

  it('chooses as trying every candidate in full would, however deep the tries nest', () => {
    for (let i = 0; i < runs(300); i++) {
      const seed = i * 7919 + 1;
      // Each decide's shape and costs follow from where it sits, so both
      // encoders meet the same ones however many tries they skip.
      const at = (depth: number, path: number, salt: number): number =>
        mulberry32(seed + depth * 100003 + path * 131 + salt * 17)();
      const write = (enc: lib.Encoder, depth: number, path: number): void => {
        const n = 2 + Math.floor(at(depth, path, 0) * 2);
        const shuffled = (salt: number): number[] =>
          Array.from({ length: n }, (_, c) => c).sort(
            (a, b) => at(depth, path * 4 + a, salt) - at(depth, path * 4 + b, salt)
          );
        enc.decide(shuffled(1), shuffled(2), (c) => {
          spend(enc, Math.floor(at(depth, path * 4 + c, 3) * 6));
          if (depth > 0) {
            write(enc, depth - 1, path * 4 + c);
          }
          spend(enc, Math.floor(at(depth, path * 4 + c, 4) * 6));
        });
      };
      const budgeted = new lib.Encoder();
      const full = new lib.Encoder({ checkDecisions: true });
      write(budgeted, 3, 0);
      write(full, 3, 0);
      expect(budgeted.output()).toEqual(full.output());
    }
  });

  it('refuses a winner written again that does not choose as its try did', () => {
    // A spelling that decides inside its try but not when written again.
    const enc = new lib.Encoder();
    let tries = 0;
    expect(() =>
      enc.decide([0, 1], [0, 1], (c) => {
        tries++;
        spend(enc, c === 0 ? 1 : 2);
        if (tries <= 2) {
          enc.decide([0], [0], () => spend(enc, 1));
        }
      })
    ).toThrow(new Error('Rewrite took 0 of 1 choices its try made'));
    // Checked, a choice that comes out otherwise.
    const checked = new lib.Encoder({ checkDecisions: true });
    let round = 0;
    expect(() =>
      checked.decide([0, 1], [0, 1], (c) => {
        spend(checked, c === 0 ? 1 : 2);
        round++;
        checked.decide([0, 1], [0, 1], (d) => spend(checked, round <= 2 ? d + 1 : 2 - d));
      })
    ).toThrow(new Error('A choice written again differs from the one its try made'));
    const noted = new lib.Encoder({ checkDecisions: true });
    let note = 0;
    expect(() =>
      noted.decide([0, 1], [0, 1], (c) => {
        spend(noted, c === 0 ? 1 : 2);
        noted.note(() => [note++]);
      })
    ).toThrow(new Error('A choice written again differs from the one its try made'));
  });
});
