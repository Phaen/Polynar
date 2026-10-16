/**
 * Methods: the method set nodes carry through rebuilds and the queries on
 * it, the previous value a node keeps, and the per-value mode that picks
 * among the methods available for a value.
 */

import { p, type PNode } from '../../index';
import { Encoder, Decoder } from '../../packer';
import { AdaptivePrior } from '../../nodes/adaptive';
import { Exclusion } from '../../nodes/excluded';
import {
  ModeChoice,
  Previous,
  bare,
  chooses,
  declaresAny,
  learningOf,
  learns,
  opened,
  recallOf,
  withMethod,
  type Method,
  type MethodName,
  type MethodSet,
  type ValueProvider,
} from '../../nodes/methods';
import { mulberry32 } from '../support';

/**
 * A method spelling a byte as one digit after a marker of 1 in `odds`
 * states, so it costs log2(odds) bits more than the byte (unable to spell
 * anything when undefined): open when `open` says so, counting the values
 * it reads, and recording every value it learns with the side that learned
 * it.
 */
class Toy implements Method<number>, ValueProvider<number> {
  readonly learned: [string, number][] = [];
  reads = 0;

  constructor(
    public odds: number | undefined,
    public open = true
  ) {}

  available(): boolean {
    return this.open;
  }

  write(enc: Encoder, value: number): void {
    if (this.odds === undefined) {
      throw new RangeError(`Toy cannot spell ${value}`);
    }
    enc.composeWeighted(0, 1, this.odds);
    if (value > 255) {
      throw new RangeError(`Toy byte ${value}`);
    }
    enc.compose(value, 256);
  }

  read(dec: Decoder): number {
    const odds = this.odds as number;
    this.reads++;
    dec.parseWeighted(odds, (r) => (r === 0 ? [0, 0, 1] : [1, 1, odds - 1]));
    return dec.parse(256);
  }

  learn(side: Encoder | Decoder, value: number): void {
    this.learned.push([side instanceof Encoder ? 'enc' : 'dec', value]);
  }
}

/** The mode over `toys`. */
const modes = (toys: readonly Toy[], adaptive?: { window?: number }): ModeChoice<number> =>
  new ModeChoice(toys, adaptive, 'test');

/** Writes `values` through `choice`, then reads them back through `back`, a choice over fresh methods of the same shape. */
const trip = (choice: ModeChoice<number>, back: ModeChoice<number>, values: readonly number[]) => {
  const enc = new Encoder();
  for (const value of values) choice.write(enc, value);
  const bytes = enc.output();
  const dec = new Decoder(bytes);
  const read = values.map(() => back.read(dec));
  dec.finalize();
  return { bytes, read };
};

describe('withMethod', () => {
  it('declares a method once, keeping the others, over one left open', () => {
    const delta = withMethod({}, 'delta', 'p.int');
    expect(delta).toEqual({ delta: 'declared' });
    expect(withMethod(delta, 'recall', 'p.int')).toEqual({ delta: 'declared', recall: 'declared' });
    expect(() => withMethod(delta, 'delta', 'p.int')).toThrow(
      new TypeError('p.int delta is already set')
    );
    expect(withMethod({ repeats: 'open' }, 'repeats', 'toy')).toEqual({ repeats: 'declared' });
  });
});

describe('opened', () => {
  it('opens every method named that is not declared, and learns under the options given', () => {
    const declared = withMethod({ digits: 'open' }, 'delta', 'p.string');
    expect(opened(declared, ['learn', 'delta', 'recall'], { window: 8 })).toEqual({
      learn: 'open',
      delta: 'declared',
      recall: 'open',
      digits: 'open',
      learning: { window: 8 },
    });
    // Opened again, the latest options hold.
    const twice = opened(opened({}, ['learn'], { window: 8 }), ['learn'], {});
    expect(twice).toEqual({ learn: 'open', learning: {} });
    expect(learningOf(twice)).toEqual({});
    expect(learningOf({ learning: { window: 8 } })).toBeUndefined();
  });
});

describe('recallOf', () => {
  it('is pinned when declared, learned when the node learns, open when opened, else none', () => {
    expect(recallOf({})).toBeUndefined();
    const pinned = recallOf({ recall: 'declared' });
    expect([pinned?.learned, pinned?.open]).toEqual([false, false]);
    const learned = recallOf({ recall: 'declared', learn: 'open' });
    expect([learned?.learned, learned?.open]).toEqual([true, false]);
    const open = recallOf({ recall: 'open', learn: 'open' });
    expect([open?.learned, open?.open]).toEqual([true, true]);
  });
});

describe('method set queries', () => {
  it('learns only with learn set', () => {
    expect(learns({})).toBe(false);
    expect(learns({ learning: { window: 8 } })).toBe(false);
    expect(learns({ learn: 'open' })).toBe(true);
  });

  it('is bare with no method at all, whatever the options', () => {
    expect(bare({})).toBe(true);
    expect(bare({ learning: {} })).toBe(true);
    expect(bare({ repeats: 'declared' })).toBe(false);
    expect(bare({ learn: 'open', learning: {} })).toBe(false);
  });

  it('declares any of the names only where one is declared', () => {
    const names: MethodName[] = ['digits', 'positional'];
    expect(declaresAny({ delta: 'declared', digits: 'open' }, names)).toBe(false);
    expect(declaresAny({ positional: 'declared' }, names)).toBe(true);
  });

  it('chooses with one of the names open and none declared', () => {
    const names: MethodName[] = ['delta', 'digits'];
    expect(chooses({}, names)).toBe(false);
    expect(chooses({ recall: 'open' }, names)).toBe(false);
    expect(chooses({ digits: 'open' }, names)).toBe(true);
    expect(chooses({ delta: 'open', digits: 'declared' }, names)).toBe(false);
  });
});

describe('Previous', () => {
  it('keeps the last value each side learned, none before the first', () => {
    const previous = new Previous<number>();
    const enc = new Encoder();
    const dec = new Decoder(new Uint8Array(0));
    expect(previous.get(enc)).toBeUndefined();
    previous.learn(enc, 4);
    previous.learn(enc, 6);
    expect([previous.get(enc), previous.get(dec)]).toEqual([6, undefined]);
  });

  it('takes back what a transaction learned when it rolls back', () => {
    const previous = new Previous<number>();
    const enc = new Encoder();
    previous.learn(enc, 4);
    const mark = enc.journal.mark();
    previous.learn(enc, 9);
    enc.journal.rollback(mark);
    expect(previous.get(enc)).toBe(4);
  });
});

describe('ModeChoice', () => {
  it('needs a method and valid adaptive options', () => {
    expect(() => new ModeChoice<number>([], undefined, 'test')).toThrow(
      new TypeError('test needs at least one method')
    );
    expect(() => modes([new Toy(2)], { window: 0 })).toThrow(RangeError);
  });

  it('refuses a value no method is available for, on both sides', () => {
    const choice = modes([new Toy(2, false), new Toy(2, false)]);
    const message = 'test has no method available for the value';
    expect(() => choice.write(new Encoder(), 1)).toThrow(new RangeError(message));
    expect(() => choice.read(new Decoder(new Uint8Array(0)))).toThrow(new RangeError(message));
  });

  it('writes no mode when one method is available, and teaches no method', () => {
    const plain = new Toy(2);
    const other = new Toy(1, false);
    const choice = modes([plain, other]);
    const { bytes, read } = trip(choice, modes([new Toy(2), new Toy(1, false)]), [7]);
    const enc = new Encoder();
    enc.composeWeighted(0, 1, 2);
    enc.compose(7, 256);
    expect(bytes).toEqual(enc.output());
    expect(read).toEqual([7]);
    expect(plain.learned).toEqual([]);
    expect(other.learned).toEqual([]);
  });

  it('picks the cheapest spelling, the lower index on a tie, as one digit over the available', () => {
    const methods = [new Toy(4), new Toy(4, false), new Toy(2), new Toy(2)];
    const choice = modes(methods);
    const enc = new Encoder();
    choice.write(enc, 9);
    // Method 2 beats 0 and ties 3; method 1 is out, so the digit is 1 of 3.
    const model = new Encoder();
    model.compose(1, 3);
    model.composeWeighted(0, 1, 2);
    model.compose(9, 256);
    expect(enc.output()).toEqual(model.output());
  });

  it('passes over a method that cannot spell the value', () => {
    const choice = modes([new Toy(8), new Toy(undefined)]);
    const enc = new Encoder();
    choice.write(enc, 3);
    const model = new Encoder();
    model.compose(0, 2);
    model.composeWeighted(0, 1, 8);
    model.compose(3, 256);
    expect(enc.output()).toEqual(model.output());
  });

  it("throws the lowest available method's error when none can spell the value", () => {
    const choice = modes([new Toy(2), new Toy(undefined)]);
    const enc = new Encoder();
    expect(() => choice.write(enc, 300)).toThrow(new RangeError('Toy byte 300'));
    // Each try is taken back, so the message holds nothing.
    expect(enc.output()).toEqual(new Encoder().output());
  });

  it('reads each value back by the method the mode names', () => {
    const write = [new Toy(4), new Toy(2), new Toy(8, false)];
    const read = [new Toy(4), new Toy(2), new Toy(8, false)];
    const back = trip(modes(write), modes(read), [1, 2, 3]);
    expect(back.read).toEqual([1, 2, 3]);
    expect(read.map((toy) => toy.reads)).toEqual([0, 3, 0]);
  });

  it('codes the mode under the adaptive prior with the unavailable methods ruled out', () => {
    const shape = (): Toy[] => [new Toy(4), new Toy(2), new Toy(2)];
    const methods = shape();
    const choice = modes(methods, { window: 64 });
    const back = shape();
    const reader = modes(back, { window: 64 });
    const values = [5, 6, 7, 8, 9, 10];
    const openings = [true, false, true, true, false, true];
    const enc = new Encoder();
    const dec: number[] = [];
    // Method 2 opens and closes from value to value, the same on both sides.
    values.forEach((value, i) => {
      methods[2].open = openings[i];
      choice.write(enc, value);
    });
    const bytes = enc.output();
    const decoder = new Decoder(bytes);
    values.forEach((_, i) => {
      back[2].open = openings[i];
      dec.push(reader.read(decoder));
    });
    decoder.finalize();
    expect(dec).toEqual(values);

    // The model: method 1 wins wherever it is available, which is always.
    const prior = new AdaptivePrior([[1, 1, 1]], 3, 64, 'test');
    const model = new Encoder();
    const without2 = new Exclusion(3);
    without2.add(2);
    values.forEach((value, i) => {
      prior.write(model, 1, 0, openings[i] ? undefined : without2);
      prior.learn(model, 1);
      model.composeWeighted(0, 1, 2);
      model.compose(value, 256);
    });
    expect(bytes).toEqual(model.output());
  });

  it('picks again where the last winner is no longer available', () => {
    const write = [new Toy(2), new Toy(1), new Toy(4)];
    const read = [new Toy(2), new Toy(1), new Toy(4)];
    const choice = modes(write);
    const back = modes(read);
    const enc = new Encoder();
    choice.write(enc, 1);
    write[1].open = false;
    choice.write(enc, 2);
    const dec = new Decoder(enc.output());
    const values = [back.read(dec)];
    read[1].open = false;
    values.push(back.read(dec));
    dec.finalize();
    expect(values).toEqual([1, 2]);
    // Method 1 won the first value; method 0 the second, without it.
    expect(read.map((toy) => toy.reads)).toEqual([1, 1, 0]);
  });

  it('prices the mode as the table learns it', () => {
    /** The method that spells a byte after `warmup` ties, once method 1 got cheaper. */
    const winner = (warmup: number): number => {
      const shape = (): Toy[] => [new Toy(2), new Toy(2)];
      const methods = shape();
      const back = shape();
      const choice = modes(methods, {});
      const reader = modes(back, {});
      const enc = new Encoder();
      // Ties go to method 0, whose mode the table learns.
      for (let i = 0; i < warmup; i++) choice.write(enc, i);
      methods[1].odds = 1;
      choice.write(enc, 255);
      const dec = new Decoder(enc.output());
      for (let i = 0; i < warmup; i++) reader.read(dec);
      back[1].odds = 1;
      reader.read(dec);
      return back[1].reads;
    };

    // Fresh, the modes are even and the cheaper spelling wins; once mode 0
    // has recurred, its cheaper mode outweighs the spelling.
    expect(winner(0)).toBe(1);
    expect(winner(30)).toBe(0);
  });
});

describe('.adaptive()', () => {
  /** A node `.adaptive()` opens, as each node type takes it. */
  interface Adaptive {
    readonly _methods: MethodSet;
    adaptive(): Adaptive & PNode<any>;
    _open(options: { window?: number }, except?: readonly MethodName[]): Adaptive & PNode<any>;
  }

  const index: MethodName[] = ['learn', 'delta', 'recall'];
  const bytes: MethodName[] = ['learn', 'delta', 'recall', 'repeats', 'terminated'];
  const text: MethodName[] = [...bytes, 'digits', 'positional'];
  const container: MethodName[] = ['learn', 'recall'];

  const random = mulberry32(11);
  const pick = <T>(list: readonly T[]): T => list[Math.floor(random() * list.length)];
  const many = <T>(make: (i: number) => T, n = 60): T[] =>
    Array.from({ length: n }, (_, i) => make(i));
  const words = ['north', 'south', 'east', 'west', 'Order-1042', 'order-1043', 'v2.10.3', ''];
  const ints = many((i) => (i % 7 === 0 ? pick([5, 9, 1000]) : 1000 + i * 3 + pick([-1, 0, 2])));

  it.each([
    ['p.int', p.int(), index, ints],
    ['p.decimal', p.decimal(0.01), index, ints.map((v) => v / 100)],
    ['p.date', p.date().precision('day'), index, ints.map((v) => new Date(v * 86400000))],
    ['p.float', p.float(), ['learn'], ints.map((v) => v / 8 + 0.1)],
    ['p.string', p.string(), text, many(() => pick(words))],
    ['a charset', p.string().charset('0123456789abcdef-'), text, many((i) => `${i % 9}-ab${i}`)],
    ['p.binary', p.binary(), bytes, many((i) => Uint8Array.of(i % 5, 7, i % 3))],
    ['p.array', p.array(p.int().min(0).max(9)), container, many((i) => [i % 3, 4, i % 5])],
    ['p.set', p.set(p.int().min(0).max(9)), container, many((i) => new Set([i % 3, 9]))],
    ['p.record', p.record(p.bool()), container, many((i) => ({ [pick(words)]: i % 2 === 0 }))],
    [
      'p.object',
      p.object({ id: p.int().min(0), name: p.optional(p.string().adaptive()) }),
      container,
      many((i) => ({ id: i % 4, name: i % 3 === 0 ? undefined : pick(words) })),
    ],
  ] as [string, Adaptive, MethodName[], unknown[]][])(
    'opens every method of %s, and round-trips under them',
    (_name, node, names, values) => {
      const adapted = node.adaptive();
      const open = Object.fromEntries(names.map((name) => [name, 'open']));
      expect(adapted._methods).toEqual({ ...open, learning: {} });
      const list = p.array(adapted);
      expect(list.decode(list.encode(values))).toEqual(values);
    }
  );

  it('keeps a declared method declared', () => {
    expect(p.int().delta().adaptive()._methods).toEqual({
      learn: 'open',
      delta: 'declared',
      recall: 'open',
      learning: {},
    });
    expect(p.string().terminated().adaptive()._methods.terminated).toBe('declared');
  });

  it('carries its options into the set it opens', () => {
    const options = { window: 64, separate: true };
    expect(p.string().adaptive(options)._methods.learning).toEqual(options);
  });

  it.each([
    ['p.bool', p.bool(), [true, true, false, true, true, true]],
    ['p.enum', p.enum(['a', 'b', 'c']), ['a', 'a', 'c', 'a', 'a', 'a']],
    ['p.optional', p.optional(p.bool()), [true, undefined, true, true, true, true]],
    ['p.nullable', p.nullable(p.bool()), [true, null, true, true, true, true]],
    ['p.union', p.union([p.bool(), p.int()]), [1, true, 2, 3, 4, 5]],
    [
      'p.tagged',
      p.tagged('k', { a: p.object({}), b: p.object({}) }),
      [{ k: 'a' }, { k: 'a' }, { k: 'b' }, { k: 'a' }, { k: 'a' }, { k: 'a' }],
    ],
    ['p.any', p.any(), [1, 'a', 2, 3, 'b', 4]],
  ] as [string, PNode<any> & { adaptive(options: object): PNode<any> }, unknown[]][])(
    'opens %s without methods as .adaptive() does',
    (_name, node, values) => {
      const opened = (node._open as (options: object) => PNode<any>)({ window: 16 });
      const bytes = p.array(opened).encode(values);
      expect(bytes).toEqual(p.array(node.adaptive({ window: 16 })).encode(values));
      expect(p.array(opened).decode(bytes)).toEqual(values);
    }
  );

  it('leaves the methods p.any names closed, and adapts a node without methods', () => {
    const text = p.string()._open({ window: 8 }, ['recall']);
    expect(text._methods.recall).toBeUndefined();
    expect(text._methods.delta).toBe('open');
    const flags = Array.from({ length: 40 }, (_, i) => i % 5 === 0);
    const adapted = p.array(p.bool()._open({ window: 16 })).encode(flags);
    expect(adapted).toEqual(p.array(p.bool().adaptive({ window: 16 })).encode(flags));
    expect(adapted).not.toEqual(p.array(p.bool()).encode(flags));
  });
});
