/**
 * Methods: the declared-methods bag nodes carry through rebuilds, and the
 * per-value mode that picks among the methods available for a value.
 */

import { Encoder, Decoder, ScaledRatio } from '../../packer';
import { AdaptivePrior } from '../../nodes/adaptive';
import { Exclusion } from '../../nodes/excluded';
import { ModeChoice, withMethod, type Method } from '../../nodes/methods';

/**
 * A method spelling a byte as one digit: open when `open` says so, priced
 * at 1 / `odds` (unable to spell anything when undefined), and recording
 * every value it learns with the side that learned it.
 */
class Toy implements Method<number> {
  readonly learned: [string, number][] = [];

  constructor(
    public odds: number | undefined,
    public open = true
  ) {}

  available(): boolean {
    return this.open;
  }

  price(_enc: Encoder, _value: number, into: ScaledRatio): boolean {
    if (this.odds === undefined) {
      return false;
    }
    into.multiply(1, this.odds);
    return true;
  }

  write(enc: Encoder, value: number): void {
    if (value > 255) {
      throw new RangeError(`Toy byte ${value}`);
    }
    enc.compose(value, 256);
  }

  read(dec: Decoder): number {
    return dec.parse(256);
  }

  learn(side: Encoder | Decoder, value: number): void {
    this.learned.push([side instanceof Encoder ? 'enc' : 'dec', value]);
  }
}

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
  it('declares a method once, keeping the others', () => {
    const delta = withMethod({}, 'delta', 'p.int');
    expect(delta).toEqual({ delta: true });
    expect(withMethod(delta, 'recall', 'p.int')).toEqual({ delta: true, recall: true });
    expect(() => withMethod(delta, 'delta', 'p.int')).toThrow(
      new TypeError('p.int delta is already set')
    );
  });
});

describe('ModeChoice', () => {
  it('needs a method and valid adaptive options', () => {
    expect(() => new ModeChoice<number>([], undefined, 'test')).toThrow(
      new TypeError('test needs at least one method')
    );
    expect(() => new ModeChoice([new Toy(2)], { window: 0 }, 'test')).toThrow(RangeError);
  });

  it('refuses a value no method is available for, on both sides', () => {
    const choice = new ModeChoice([new Toy(2, false), new Toy(2, false)], undefined, 'test');
    const message = 'test has no method available for the value';
    expect(() => choice.write(new Encoder(), 1)).toThrow(new RangeError(message));
    expect(() => choice.read(new Decoder(new Uint8Array(0)))).toThrow(new RangeError(message));
  });

  it('writes no mode when one method is available', () => {
    const plain = new Toy(2);
    const other = new Toy(1, false);
    const { bytes, read } = trip(
      new ModeChoice([plain, other], undefined, 'test'),
      new ModeChoice([new Toy(2), new Toy(1, false)], undefined, 'test'),
      [7]
    );
    const enc = new Encoder();
    enc.compose(7, 256);
    expect(bytes).toEqual(enc.output());
    expect(read).toEqual([7]);
    expect(plain.learned).toEqual([]);
    expect(other.learned).toEqual([]);
  });

  it('picks the likeliest spelling, the lower index on a tie, as one digit over the available', () => {
    const methods = [new Toy(4), new Toy(4, false), new Toy(2), new Toy(2)];
    const choice = new ModeChoice(methods, undefined, 'test');
    const enc = new Encoder();
    choice.write(enc, 9);
    // Method 2 beats 0 and ties 3; method 1 is out, so the digit is 1 of 3.
    const model = new Encoder();
    model.compose(1, 3);
    model.compose(9, 256);
    expect(enc.output()).toEqual(model.output());
    // Every other available method learned the value, in index order.
    expect(methods.map((m) => m.learned)).toEqual([[['enc', 9]], [], [], [['enc', 9]]]);
  });

  it('passes over a method that cannot spell the value', () => {
    const choice = new ModeChoice([new Toy(8), new Toy(undefined)], undefined, 'test');
    const enc = new Encoder();
    choice.write(enc, 3);
    const model = new Encoder();
    model.compose(0, 2);
    model.compose(3, 256);
    expect(enc.output()).toEqual(model.output());
  });

  it("throws the lowest available method's error when none can spell the value", () => {
    const choice = new ModeChoice([new Toy(undefined), new Toy(undefined)], undefined, 'test');
    expect(() => choice.write(new Encoder(), 300)).toThrow(new RangeError('Toy byte 300'));
  });

  it('reads the mode back and teaches the other available methods on the decoder', () => {
    const write = [new Toy(4), new Toy(2), new Toy(8, false)];
    const read = [new Toy(4), new Toy(2), new Toy(8, false)];
    const back = trip(
      new ModeChoice(write, undefined, 'test'),
      new ModeChoice(read, undefined, 'test'),
      [1, 2, 3]
    );
    expect(back.read).toEqual([1, 2, 3]);
    expect(read.map((m) => m.learned)).toEqual([
      [
        ['dec', 1],
        ['dec', 2],
        ['dec', 3],
      ],
      [],
      [],
    ]);
  });

  it('codes the mode under the adaptive prior with the unavailable methods ruled out', () => {
    const shape = (): Toy[] => [new Toy(4), new Toy(2), new Toy(2)];
    const methods = shape();
    const choice = new ModeChoice(methods, { window: 64 }, 'test');
    const back = shape();
    const reader = new ModeChoice(back, { window: 64 }, 'test');
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
      model.compose(value, 256);
    });
    expect(bytes).toEqual(model.output());
  });

  it('prices the mode by the adaptive estimate', () => {
    const winner = (warmup: number): number => {
      const methods = [new Toy(2), new Toy(2)];
      const choice = new ModeChoice(methods, {}, 'test');
      const enc = new Encoder();
      // Ties go to method 0, whose mode the table learns.
      for (let i = 0; i < warmup; i++) choice.write(enc, i);
      methods[1].odds = 1.9;
      const before = methods[0].learned.length;
      choice.write(enc, 255);
      return methods[0].learned.length > before ? 1 : 0;
    };
    // Fresh, the modes are even and the cheaper spelling wins; once mode 0
    // has recurred, its cheaper mode outweighs the spelling.
    expect(winner(0)).toBe(1);
    expect(winner(30)).toBe(0);
  });
});
