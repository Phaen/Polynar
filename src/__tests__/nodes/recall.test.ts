/**
 * Recall: values spelled by their place among the distinct values a message
 * has already coded, or in full the first time.
 */

import { p, Encoder, Decoder, type PNode } from '../../index';
import { PRecall, Recall, copy, identity } from '../../nodes/recall';
import type { MethodName, MethodNode } from '../../nodes/methods';
import { mulberry32 } from '../support';

/** The methods a test leaves closed on a node it adapts: its own recall. */
const RECALLED: readonly MethodName[] = ['recall'];

const strings = () => new PRecall<string>(p.string(), (s) => s);
const keyLists = () => new PRecall<string[]>(p.array(p.string()), (keys) => JSON.stringify(keys));

/** Writes every value through `node` into one message and reads them back. */
const tripAll = <T>(node: PRecall<T>, values: readonly T[]): { bytes: Uint8Array; back: T[] } => {
  const enc = new Encoder();
  for (const value of values) node._write(enc, value);
  const bytes = enc.output();
  const dec = new Decoder(bytes);
  const back = values.map(() => node._read(dec));
  dec.finalize();
  return { bytes, back };
};

/**
 * The message a recall should write, from plain lists of counts: whether
 * the value is new (0) or seen (1), out of counts starting at [1, 1],
 * gaining 32 each and halving, rounding up, past a total of 1024; then a seen
 * value's member among the values in order of first appearance, each
 * counting 1 when new and 1 more per recall.
 */
const model = (values: readonly string[]): Uint8Array => {
  const enc = new Encoder();
  const fresh = [1, 1];
  const counts: number[] = [];
  const seen: string[] = [];
  const symbol = (table: number[], member: number) => {
    if (table.length > 1) {
      const total = table.reduce((a, b) => a + b, 0);
      const cum = table.slice(0, member).reduce((a, b) => a + b, 0);
      enc.composeWeighted(cum, table[member], total);
    }
  };
  for (const value of values) {
    const at = seen.indexOf(value);
    if (seen.length > 0) {
      const recalled = at >= 0 ? 1 : 0;
      symbol(fresh, recalled);
      fresh[recalled] += 32;
      if (fresh[0] + fresh[1] > 1024) {
        fresh[0] = Math.ceil(fresh[0] / 2);
        fresh[1] = Math.ceil(fresh[1] / 2);
      }
    }
    if (at >= 0) {
      symbol(counts, at);
      counts[at]++;
    } else {
      p.string()._write(enc, value);
      counts.push(1);
      seen.push(value);
    }
  }
  return enc.output();
};

describe('PRecall', () => {
  it('takes its kinds from the inner node', () => {
    expect(strings()._kinds).toEqual(['string']);
    expect(keyLists()._kinds).toEqual(['array']);
  });

  it.each([
    ['one new value', ['a']],
    ['a repeat', ['a', 'a', 'a']],
    ['many distinct values', Array.from({ length: 50 }, (_, i) => `v${i}`)],
    ['interleaved values', ['a', 'b', 'a', 'c', 'b', 'b', 'd', 'a', '']],
  ])('round-trips %s', (_name, values) => {
    expect(tripAll(strings(), values).back).toEqual(values);
  });

  it('round-trips key lists, matched by their JSON', () => {
    const values = [['a', 'b'], [], ['a', 'b'], ['b', 'a'], [], ['a,b'], ['b', 'a']];
    const { back } = tripAll(keyLists(), values);
    expect(back).toEqual(values);
    // A recalled value is the one first decoded, not a copy.
    expect(back[2]).toBe(back[0]);
  });

  it('shares a recall it is given, so a value one node spelled recalls through another', () => {
    const shared = new Recall<string>({ learned: true });
    const upper = new PRecall<string>(p.string().charset('AB'), (s) => s, shared);
    const lower = new PRecall<string>(p.string(), (s) => s, shared);
    const enc = new Encoder();
    upper._write(enc, 'AB');
    lower._write(enc, 'AB');
    lower._write(enc, 'ab');
    const dec = new Decoder(enc.output());
    expect([upper._read(dec), lower._read(dec), lower._read(dec)]).toEqual(['AB', 'AB', 'ab']);
    dec.finalize();
    const twice = (second: PNode<string>) => {
      const out = new Encoder();
      upper._write(out, 'AB');
      second._write(out, 'AB');
      return out.output().length;
    };
    expect(twice(lower)).toBeLessThan(twice(strings()));
  });

  it('writes nothing for the first value beyond its spelling', () => {
    const enc = new Encoder();
    p.string()._write(enc, 'hello');
    expect(tripAll(strings(), ['hello']).bytes).toEqual(enc.output());
  });

  it('spells a repeat in fewer bits than a new value', () => {
    const repeat = tripAll(strings(), ['hello', 'hello', 'hello', 'hello']).bytes;
    const fresh = tripAll(strings(), ['hello', 'world', 'there', 'again']).bytes;
    expect(repeat.length).toBeLessThan(fresh.length);
    expect(repeat.length).toBeLessThanOrEqual(tripAll(strings(), ['hello']).bytes.length + 1);
  });

  it('counts each member as a plain list of counts does, over a seeded sequence', () => {
    const rand = mulberry32(7);
    const pool = ['ok', 'warn', 'error', 'down', 'up', 'idle'];
    const values = Array.from({ length: 300 }, () => pool[Math.floor(rand() ** 2 * pool.length)]);
    const { bytes, back } = tripAll(strings(), values);
    expect(back).toEqual(values);
    expect(bytes).toEqual(model(values));
  });

  it('reads a value spelled as new when it is already recalled, as a new member', () => {
    const enc = new Encoder();
    // The first value writes no flag and no member.
    p.string()._write(enc, 'a');
    // New, out of [new 1, seen 1], then the same text.
    enc.composeWeighted(0, 1, 2);
    p.string()._write(enc, 'a');
    // Seen, out of [new 33, seen 1]; then member 1, the second copy, out of [a 1, a 1].
    enc.composeWeighted(33, 1, 34);
    enc.composeWeighted(1, 1, 2);
    const node = strings();
    const dec = new Decoder(enc.output());
    expect(node._read(dec)).toBe('a');
    expect(node._read(dec)).toBe('a');
    expect(node._read(dec)).toBe('a');
    dec.finalize();
  });

  it('learns that values never recur, so the escape costs next to nothing', () => {
    const values = Array.from({ length: 300 }, (_, i) => `v${i}`);
    const enc = new Encoder();
    for (const value of values) p.string()._write(enc, value);
    expect(tripAll(strings(), values).bytes.length - enc.output().length).toBeLessThan(10);
  });

  it('takes back what a rolled-back write learned, a halving included', () => {
    const node = strings();
    const enc = new Encoder();
    for (const value of ['a', 'b', 'a']) node._write(enc, value);
    const mark = enc.mark();
    const tried = Array.from({ length: 40 }, (_, i) => (i % 3 ? `t${i}` : 'a'));
    for (const value of tried) node._write(enc, value);
    enc.rollback(mark);
    for (const value of ['b', 'e', 'a']) node._write(enc, value);
    expect(enc.output()).toEqual(model(['a', 'b', 'a', 'b', 'e', 'a']));
  });

  /** `n` values, each new one time in five, else one of the four latest new ones. */
  const recent = (seed: number, n: number): string[] => {
    const rand = mulberry32(seed);
    const made: string[] = [];
    return Array.from({ length: n }, () => {
      if (made.length === 0 || rand() < 0.2) {
        made.push(`v${made.length}`);
        return made[made.length - 1];
      }
      return made[Math.max(0, made.length - 1 - Math.floor(rand() * 4))];
    });
  };

  it('spells a seen value by its recency once that costs less than its count', () => {
    const values = recent(8, 400);
    const { bytes, back } = tripAll(strings(), values);
    expect(back).toEqual(values);
    expect(bytes.length).toBeLessThan(model(values).length - 40);
  });

  it('takes back what a rolled-back write learned of recency', () => {
    const node = strings();
    const before = recent(9, 200);
    const after = recent(10, 100).map((value) => `${value}x`);
    const enc = new Encoder();
    for (const value of before) node._write(enc, value);
    const mark = enc.mark();
    for (const value of recent(11, 150)) node._write(enc, value);
    enc.rollback(mark);
    for (const value of after) node._write(enc, value);
    const { bytes, back } = tripAll(strings(), [...before, ...after]);
    expect(back).toEqual([...before, ...after]);
    expect(enc.output()).toEqual(bytes);
  });

  it('keeps a separate pool per node in one message', () => {
    const first = strings();
    const second = strings();
    const enc = new Encoder();
    first._write(enc, 'a');
    second._write(enc, 'b');
    first._write(enc, 'a');
    second._write(enc, 'a');
    const dec = new Decoder(enc.output());
    expect([first._read(dec), second._read(dec), first._read(dec), second._read(dec)]).toEqual([
      'a',
      'b',
      'a',
      'a',
    ]);
    dec.finalize();
  });

  it('starts every message empty', () => {
    const node = strings();
    const once = tripAll(node, ['a', 'b', 'a']).bytes;
    expect(tripAll(node, ['a', 'b', 'a']).bytes).toEqual(once);
    const enc = new Encoder();
    p.string()._write(enc, 'b');
    expect(tripAll(node, ['b']).bytes).toEqual(enc.output());
  });
});

describe('identity', () => {
  it('is the symbols of the value spelled alone, each its bucket and total', () => {
    expect(identity(() => {})).toBe('');
    expect(identity((enc) => enc.compose(1, 3))).toBe('1/3,');
    expect(identity((enc) => enc.composeWeighted(1, 2, 5))).toBe('1+2/5,');
    const node = p.array(p.int().min(0).max(9));
    const key = (value: number[]): string => identity((enc) => node._write(enc, value));
    expect(key([1, 2])).toBe(key([1, 2]));
    expect(key([1, 2])).not.toBe(key([2, 1]));
    expect(key([1, 2])).not.toBe(key([1, 2, 0]));
  });

  it('writes the key of each value through a recall inside it, or spells it when the key is computed', () => {
    const recall = new Recall<number>({ learned: true });
    const twice = identity((enc) => {
      for (let i = 0; i < 2; i++) recall.write(enc, 'k', () => enc.compose(1, 3));
    });
    const k = `1/${Number.MAX_SAFE_INTEGER},${'k'.charCodeAt(0)}/65536,`;
    expect(twice).toBe(k + k);
    const asked = jest.fn(() => 'k');
    const spelled = identity((enc) => {
      for (let i = 0; i < 2; i++) recall.write(enc, asked, () => enc.compose(1, 3));
    });
    expect(spelled).toBe('1/3,1/3,');
    expect(asked).not.toHaveBeenCalled();
    // Outside an identity the second write is recalled.
    const enc = new Encoder();
    const hits = [0, 1].map(() => recall.write(enc, 'k', () => enc.compose(1, 3)));
    expect(hits).toEqual([false, true]);
  });

  it('measures nested recalls by their keys, so a deep value is spelled once', () => {
    let spelled = 0;
    const leaf = new PRecall<number>(
      {
        _write: (enc: Encoder, v: number) => {
          spelled++;
          enc.compose(v, 9);
        },
      } as unknown as PNode<number>,
      String
    );
    let node: PNode<any> = leaf;
    for (let depth = 0; depth < 8; depth++) node = p.array(node).recall();
    node.encode([[[[[[[[3]]]]]]]]);
    // Each level's identity writes the leaf's key, so the leaf spells only
    // when written; each array's own identity is measured once, by the
    // level written, not again inside the levels around it.
    expect(spelled).toBe(1);
  });
});

describe('copy', () => {
  it('passes primitives through', () => {
    for (const value of [undefined, null, 1, -0, 'a', true, 2n, Symbol.iterator]) {
      expect(Object.is(copy(value), value)).toBe(true);
    }
  });

  it('copies plain objects deeply, an own __proto__ key and a null prototype kept', () => {
    const inner = { b: [1, { c: 2 }] };
    const value: Record<string, unknown> = { a: inner };
    Object.defineProperty(value, '__proto__', { value: 7, enumerable: true, writable: true });
    const out = copy(value);
    expect(out).toEqual(value);
    expect(out.a).not.toBe(inner);
    expect((out.a as typeof inner).b[1]).not.toBe(inner.b[1]);
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect(Object.keys(out)).toEqual(['a', '__proto__']);
    expect(Object.getOwnPropertyDescriptor(out, '__proto__')?.value).toBe(7);
    const bare = Object.create(null) as Record<string, number[]>;
    bare.x = [1];
    const copied = copy(bare);
    expect(Object.getPrototypeOf(copied)).toBeNull();
    expect(copied.x).toEqual([1]);
    expect(copied.x).not.toBe(bare.x);
  });

  it('copies Maps, Sets, Dates and RegExps, with their contents', () => {
    const key = { k: 1 };
    const map = new Map<unknown, unknown>([[key, [1]]]);
    const outMap = copy(map);
    expect(outMap).toEqual(map);
    const [[outKey, outItem]] = [...outMap];
    expect(outKey).not.toBe(key);
    expect(outItem).not.toBe(map.get(key));
    const member = [2];
    const outSet = copy(new Set([member]));
    expect([...outSet]).toEqual([[2]]);
    expect([...outSet][0]).not.toBe(member);
    const date = new Date(5);
    expect(copy(date)).toEqual(date);
    expect(copy(date)).not.toBe(date);
    const regexp = /a+/gi;
    expect(copy(regexp)).toEqual(regexp);
    expect(copy(regexp)).not.toBe(regexp);
  });

  it('copies buffers and views into buffers of their own, keeping the class', () => {
    const buffer = new Uint8Array([1, 2, 3, 4]).buffer;
    const outBuffer = copy(buffer);
    expect(new Uint8Array(outBuffer)).toEqual(new Uint8Array([1, 2, 3, 4]));
    expect(outBuffer).not.toBe(buffer);
    const view = new DataView(buffer, 1, 2);
    const outView = copy(view);
    expect(outView.byteLength).toBe(2);
    expect(outView.getUint8(0)).toBe(2);
    expect(outView.buffer).not.toBe(buffer);
    const floats = new Float64Array(new Float64Array([1, 2, 3]).buffer, 8, 2);
    const outFloats = copy(floats);
    expect(outFloats).toBeInstanceOf(Float64Array);
    expect([...outFloats]).toEqual([2, 3]);
    expect(outFloats.buffer).not.toBe(floats.buffer);
    const bytes = Buffer.from([7, 8]);
    const outBytes = copy(bytes);
    expect(Buffer.isBuffer(outBytes)).toBe(true);
    outBytes[0] = 0;
    expect(bytes[0]).toBe(7);
  });

  it('passes instances of other classes through', () => {
    class Point {
      constructor(readonly x: number) {}
    }
    const point = new Point(1);
    expect(copy(point)).toBe(point);
    expect(copy([point])[0]).toBe(point);
  });
});

describe('Recall', () => {
  /** Writes `keys` through a recall, each new one spelled as its own digit in radix 9. */
  const writeAll = (recall: Recall<number>, keys: readonly number[]) => {
    const enc = new Encoder();
    const hits = keys.map((k) => recall.write(enc, String(k), () => enc.compose(k, 9)));
    return { bytes: enc.output(), hits };
  };

  it('spells a member uniformly over "new" and the values seen, without learning', () => {
    const { bytes, hits } = writeAll(new Recall(), [4, 4, 7, 4, 7, 8]);
    expect(hits).toEqual([false, true, false, true, true, false]);
    const model = new Encoder();
    model.compose(4, 9);
    model.compose(1, 2);
    model.compose(0, 2);
    model.compose(7, 9);
    model.compose(1, 3);
    model.compose(2, 3);
    model.compose(0, 3);
    model.compose(8, 9);
    expect(bytes).toEqual(model.output());
    const dec = new Decoder(bytes);
    const recall = new Recall<number>();
    const back = [0, 1, 2, 3, 4, 5].map(() => recall.read(dec, () => dec.parse(9)));
    dec.finalize();
    expect(back).toEqual([4, 4, 7, 4, 7, 8]);
  });

  it('reads a recalled value through its copy', () => {
    const enc = new Encoder();
    const recall = new Recall<number[]>({ copy: (v) => [...v] });
    for (const v of [[1], [1]]) recall.write(enc, String(v), () => enc.compose(v[0], 9));
    const dec = new Decoder(enc.output());
    const reader = new Recall<number[]>({ copy: (v) => [...v] });
    const first = reader.read(dec, () => [dec.parse(9)]);
    const second = reader.read(dec, () => [dec.parse(9)]);
    expect(second).toEqual(first);
    expect(second).not.toBe(first);
  });

  it('spells a seen value in full when open and that costs less, the decoder listing it again', () => {
    const recall = new Recall<number>({ open: true });
    expect(recall.learned).toBe(true);
    // After two new values the seen flag and member cost more than the spelling.
    const { bytes, hits } = writeAll(recall, [1, 2, 3, 1]);
    expect(hits).toEqual([false, false, false, false]);
    const model = new Encoder();
    model.compose(1, 9);
    model.composeWeighted(0, 1, 2);
    model.compose(2, 9);
    model.composeWeighted(0, 33, 34);
    model.compose(3, 9);
    model.composeWeighted(0, 65, 66);
    model.compose(1, 9);
    expect(bytes).toEqual(model.output());
    const dec = new Decoder(bytes);
    const reader = new Recall<number>({ open: true });
    const back = [0, 1, 2, 3].map(() => reader.read(dec, () => dec.parse(9)));
    dec.finalize();
    expect(back).toEqual([1, 2, 3, 1]);
  });

  it('recalls a seen value when open and recalling costs less, by its first member', () => {
    const recall = new Recall<number>({ open: true });
    const enc = new Encoder();
    // A spelling dear enough that recalling wins from the start.
    const spell = (k: number) => () => {
      for (let i = 0; i < 8; i++) enc.compose(k, 9);
    };
    const hits = [5, 6, 5, 6].map((k) => recall.write(enc, String(k), spell(k)));
    expect(hits).toEqual([false, false, true, true]);
    const dec = new Decoder(enc.output());
    const reader = new Recall<number>({ open: true });
    const read = () =>
      reader.read(dec, () => {
        const k = dec.parse(9);
        for (let i = 1; i < 8; i++) dec.parse(9);
        return k;
      });
    expect([read(), read(), read(), read()]).toEqual([5, 6, 5, 6]);
    dec.finalize();
  });

  it('spells as PRecall does when learned', () => {
    const values = ['a', 'b', 'a', 'a', 'c', 'b'];
    const recall = new Recall<string>({ learned: true });
    const enc = new Encoder();
    for (const v of values) recall.write(enc, v, () => p.string()._write(enc, v));
    expect(enc.output()).toEqual(tripAll(strings(), values).bytes);
  });
});

/** A message of `values` written one after another by `node`, and read back. */
const inOne = <T>(node: PNode<T>, values: readonly T[]) => {
  const enc = new Encoder();
  for (const value of values) node._write(enc, value);
  const bytes = enc.output();
  const dec = new Decoder(bytes);
  const back = values.map(() => node._read(dec));
  dec.finalize();
  return { bytes, back };
};

describe('.recall()', () => {
  const item = p.int().min(0).max(255);

  it('costs a repeated object log2(seen + 1) bits', () => {
    const node = p.object({ a: item, b: p.bool() }).recall();
    const one = { a: 7, b: true };
    const two = { a: 9, b: false };
    const { bytes, back } = inOne(node, [one, two, one, two, two]);
    expect(back).toEqual([one, two, one, two, two]);
    const model = new Encoder();
    model.compose(7, 256);
    model.compose(0, 2);
    model.compose(0, 2);
    model.compose(9, 256);
    model.compose(1, 2);
    model.compose(1, 3);
    model.compose(2, 3);
    model.compose(2, 3);
    expect(bytes).toEqual(model.output());
    // A repeat decodes as a copy of the object first decoded.
    expect(back[2]).not.toBe(back[0]);
  });

  it('decodes each repeat as its own copy, so mutating one leaves the others intact', () => {
    const node = p.array(
      p
        .object({
          tags: p.array(p.string()),
          at: p.date(),
          seen: p.set(item),
          bytes: p.binary(),
        })
        .recall()
    );
    const entry = () => ({
      tags: ['a'],
      at: new Date(0),
      seen: new Set([1]),
      bytes: new Uint8Array([1, 2]),
    });
    const back = node.decode(node.encode([entry(), entry(), entry()]));
    back[1].tags.push('b');
    back[1].at.setTime(5);
    back[1].seen.add(2);
    back[1].bytes[0] = 9;
    expect(back[0]).toEqual(entry());
    expect(back[2]).toEqual(entry());

    const arrays = p.array(p.array(item).recall());
    const lists = arrays.decode(arrays.encode([[1], [1]]));
    lists[1].push(2);
    expect(lists).toEqual([[1], [1, 2]]);
    const maps = p.array(p.map(p.string(), item).recall());
    const decoded = maps.decode(maps.encode([new Map([['a', 1]]), new Map([['a', 1]])]));
    decoded[1].set('b', 2);
    expect(decoded[0]).toEqual(new Map([['a', 1]]));
  });

  it('writes nothing extra for a node written once, and matches values by their spelling', () => {
    const node = p.object({ a: item }).recall();
    expect(node.encode({ a: 3 })).toEqual(p.object({ a: item }).encode({ a: 3 }));
    // An extra key is not part of the spelling, so the second object is a repeat.
    const loose = { a: 3, z: 1 } as { a: number };
    const { bytes, back } = inOne(node, [{ a: 3 }, loose]);
    expect(back).toEqual([{ a: 3 }, { a: 3 }]);
    const model = new Encoder();
    model.compose(3, 256);
    model.compose(1, 2);
    expect(bytes).toEqual(model.output());
  });

  it('recalls arrays, learning the odds when the count is adaptive', () => {
    const plain = p.array(item).max(4);
    const values = [[1, 2], [3], [1, 2], [1, 2], [], [3], [1, 2]];
    const fixed = inOne(plain.recall(), values);
    expect(fixed.back).toEqual(values);
    const learned = inOne(plain.adaptive().recall(), values);
    expect(learned.back).toEqual(values);
    // The model's own node opens no recall, so the model's is the only one.
    const spelled = plain._open({}, RECALLED);
    const model = new PRecall<number[]>(spelled, (v) => identity((enc) => spelled._write(enc, v)));
    expect(learned.bytes).toEqual(inOne(model, values).bytes);
  });

  it.each([
    ['map', p.map(p.string(), item), [new Map([['a', 1]]), new Map(), new Map([['a', 1]])]],
    [
      'record',
      p.record(item),
      [
        { x: 1, y: 2 },
        { x: 1, y: 2 },
        { y: 2, x: 1 },
      ],
    ],
    ['set', p.set(item), [new Set([1, 2]), new Set([2, 1]), new Set([1, 2])]],
  ] as [string, PNode<any>, unknown[]][])('recalls a %s', (_name, node, values) => {
    const recalled = (node as unknown as { recall(): PNode<unknown> }).recall();
    const { bytes, back } = inOne(recalled, values);
    expect(back).toEqual(values);
    expect(bytes.length).toBeLessThan(inOne(node, values).bytes.length);
  });

  it('learns the odds of an adaptive collection', () => {
    const node = p.set(item).max(3).adaptive().recall();
    const values = [new Set([1]), new Set([1]), new Set([1]), new Set([2])];
    const spelled = p.set(item).max(3)._open({}, RECALLED);
    const model = new PRecall<Set<number>>(spelled, (v) =>
      identity((enc) => spelled._write(enc, v))
    );
    expect(inOne(node, values).bytes).toEqual(inOne(model, values).bytes);
  });

  it('survives the other refinements, and is set once', () => {
    const values = [[1], [1], [1]];
    const array = p.array(item).recall().min(0).max(9).weights(new Array(10).fill(1)).sorted();
    expect(inOne(array, values).back).toEqual(values);
    expect(inOne(p.array(item).recall().unique().unordered(), values).back).toEqual(values);
    expect(inOne(p.array(item).recall().length(1), values).back).toEqual(values);
    expect(() => p.array(item).recall().recall()).toThrow(
      new TypeError('p.array recall is already set')
    );
    expect(() => p.object({}).recall().recall()).toThrow('p.object recall is already set');
    expect(() => p.set(item).recall().recall()).toThrow('p.set recall is already set');
    const sets = [new Set([1, 2]), new Set([1, 2])];
    const set = p.set(item).recall().min(1).max(3).weights([1, 1, 1]).unordered();
    expect(inOne(set, sets).back).toEqual(sets);
    expect(inOne(p.set(item).recall().length(2), sets).back).toEqual(sets);
    const counted = p
      .set(item)
      .recall()
      .max(3)
      .cdf((n) => n);
    expect(inOne(counted, sets).back).toEqual(sets);
    const record = p.record(item).recall().max(3).adaptive();
    expect(inOne(record, [{ a: 1 }, { a: 1 }]).back).toEqual([{ a: 1 }, { a: 1 }]);
  });

  it('names the path of a value that fails, as without recall', () => {
    const node = p.array(p.object({ a: item }).recall()).recall();
    expect(() => node.encode([{ a: 1 }, { a: 300 }])).toThrow(/\[1\]\.a/);
  });
});

describe('.adaptive() recall', () => {
  const item = p.int().min(0).max(255);
  const int = <N extends MethodNode<any>>(node: N): N => node._open({}, RECALLED);

  it('recalls by default under .adaptive(), at learned odds, unless declared', () => {
    const values = ['north', 'south', 'north', 'north', 'east', 'south'];
    const open = inOne(p.string().adaptive(), values);
    expect(open.back).toEqual(values);
    expect(open.bytes.length).toBeLessThan(
      inOne(p.string()._open({}, RECALLED), values).bytes.length
    );
    const ints = [1e9, 7, 1e9, 1e9, 7];
    expect(inOne(p.int().adaptive(), ints).bytes.length).toBeLessThan(
      inOne(int(p.int()), ints).bytes.length
    );
    // A declared recall is pinned: a value seen is always recalled.
    const cycle = Array.from({ length: 1000 }, (_, i) => i % 200);
    const bytes = p.array(item.adaptive()).encode(cycle).length;
    expect(bytes).toBeLessThanOrEqual(p.array(int(item)).encode(cycle).length + 1);
    expect(p.array(item.recall().adaptive()).encode(cycle).length).toBeGreaterThan(bytes * 10);
  });

  it('costs next to nothing where values never recur', () => {
    const distinct = Array.from({ length: 1000 }, (_, i) => `user-${i * 7919}`);
    const ids = Array.from({ length: 1000 }, (_, i) => 1000 + i * 3);
    const cases: [PNode<any>, PNode<any>, unknown[]][] = [
      [p.array(p.string().adaptive()), p.array(p.string()._open({}, RECALLED)), distinct],
      [p.array(p.int().min(0).adaptive()), p.array(int(p.int().min(0))), ids],
      [
        p.array(p.object({ id: int(p.int().min(0)) }).adaptive()),
        p.array(p.object({ id: int(p.int().min(0)) })),
        ids.map((id) => ({ id })),
      ],
    ];
    for (const [open, shut, values] of cases) {
      expect(open.encode(values).length).toBeLessThanOrEqual(shut.encode(values).length + 1);
    }
  });

  it('keeps the methods that close it through every rebuild', () => {
    const values = [5, 5, 5, 9];
    const before = int(p.int().min(0).max(99));
    const after = int(p.int()).min(0).max(99);

    expect(inOne(after, values).bytes).toEqual(inOne(before, values).bytes);
    const open = p.int().min(0).max(99).adaptive();
    expect(inOne(open, values).bytes).not.toEqual(inOne(before, values).bytes);
  });

  it('learns object recall under p.object().adaptive()', () => {
    const shape = { a: item, b: p.bool() };
    const node = p.object(shape).adaptive();
    const one = { a: 7, b: true };
    const values = [one, { a: 9, b: false }, one, one, one];
    const { bytes, back } = inOne(node, values);
    expect(back).toEqual(values);
    // A repeat decodes as a copy.
    expect(back[2]).not.toBe(back[0]);
    const spelled = p.object(shape);
    const model = new PRecall<{ a: number; b: boolean }>(spelled, (v) =>
      identity((enc) => spelled._write(enc, v))
    );
    expect(bytes).toEqual(inOne(model, values).bytes);
    expect(node.encode(one)).toEqual(spelled.encode(one));
    // Declared, the recall is pinned and learned, in either order.
    const pinned = inOne(p.object(shape).recall().adaptive(), values).bytes;
    expect(inOne(p.object(shape).adaptive().recall(), values).bytes).toEqual(pinned);
  });

  it('writes record keys through an adaptive string under p.record().adaptive()', () => {
    const records: Record<string, number>[] = [
      { id: 1, count: 2 },
      { id: 3, count: 4, extra: 5 },
      { id: 1, count: 2 },
    ];
    const maps = records.map((record) => new Map(Object.entries(record)));
    const adaptive = p.record(item).adaptive();
    const { bytes, back } = inOne(adaptive, records);
    expect(back).toEqual(records);
    const twin = p.map(p.string().adaptive(), item).adaptive();
    expect(bytes).toEqual(inOne(twin, maps).bytes);
    // Without .adaptive() the keys stay plain strings.
    expect(inOne(p.record(item), records).bytes).toEqual(
      inOne(p.map(p.string(), item), maps).bytes
    );
    const unordered = p.record(item).adaptive().unordered();
    expect(inOne(unordered, records).back).toEqual(records);
  });
});
