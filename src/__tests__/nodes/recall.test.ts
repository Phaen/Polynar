/**
 * Recall: values spelled by their place among the distinct values a message
 * has already coded, or in full the first time.
 */

import { p, Encoder, Decoder, CorruptInputError, type PNode } from '../../index';
import { PRecall, Recall, copy, identity } from '../../nodes/recall';
import { mulberry32 } from '../support';

const strings = () => new PRecall<string>(p.string(), (s) => s, 'test string');
const keyLists = () =>
  new PRecall<string[]>(p.array(p.string()), (keys) => JSON.stringify(keys), 'test shape');

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
 * The message a recall should write, from a plain list of counts: member 0
 * is "new", every later member a value in order of first appearance.
 */
const model = (values: readonly string[]): Uint8Array => {
  const enc = new Encoder();
  const counts = [1];
  const seen: string[] = [];
  const symbol = (member: number) => {
    const total = counts.reduce((a, b) => a + b, 0);
    if (counts.length > 1) {
      const cum = counts.slice(0, member).reduce((a, b) => a + b, 0);
      enc.composeWeighted(cum, counts[member], total, { index: member, count: counts.length });
    }
    counts[member]++;
  };
  for (const value of values) {
    const at = seen.indexOf(value);
    if (at >= 0) {
      symbol(at + 1);
    } else {
      symbol(0);
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
    // Member 0 with the table at one member writes nothing.
    p.string()._write(enc, 'a');
    // Member 0 again, now out of [1, 1], then the same text.
    enc.composeWeighted(0, 2, 3, { index: 0, count: 2 });
    p.string()._write(enc, 'a');
    // Member 2, the second copy, out of [new 3, a 1, a 1].
    enc.composeWeighted(4, 1, 5, { index: 2, count: 3 });
    const node = strings();
    const dec = new Decoder(enc.output());
    expect(node._read(dec)).toBe('a');
    expect(node._read(dec)).toBe('a');
    expect(node._read(dec)).toBe('a');
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
  it('is the text of the value spelled alone', () => {
    const node = p.array(p.int().min(0).max(9));
    expect(identity((enc) => node._write(enc, [1, 2]))).toBe(node.encode([1, 2], { type: 'text' }));
    expect(identity(() => {})).toBe(new Encoder().output({ type: 'text' }));
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
    const { bytes, hits } = writeAll(new Recall(false), [4, 4, 7, 4, 7, 8]);
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
    const recall = new Recall<number>(false);
    const back = [0, 1, 2, 3, 4, 5].map(() => recall.read(dec, () => dec.parse(9)));
    dec.finalize();
    expect(back).toEqual([4, 4, 7, 4, 7, 8]);
  });

  it('reads a recalled value through its copy', () => {
    const enc = new Encoder();
    const recall = new Recall<number[]>(false, (v) => [...v]);
    for (const v of [[1], [1]]) recall.write(enc, String(v), () => enc.compose(v[0], 9));
    const dec = new Decoder(enc.output());
    const reader = new Recall<number[]>(false, (v) => [...v]);
    const first = reader.read(dec, () => [dec.parse(9)]);
    const second = reader.read(dec, () => [dec.parse(9)]);
    expect(second).toEqual(first);
    expect(second).not.toBe(first);
  });

  it('spells as PRecall does when learned', () => {
    const values = ['a', 'b', 'a', 'a', 'c', 'b'];
    const recall = new Recall<string>(true);
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
    const spelled = plain.adaptive();
    const model = new PRecall<number[]>(
      spelled,
      (v) => identity((enc) => spelled._write(enc, v)),
      'model'
    );
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
    const spelled = p.set(item).max(3).adaptive();
    const model = new PRecall<Set<number>>(
      spelled,
      (v) => identity((enc) => spelled._write(enc, v)),
      'model'
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

  it('refuses corrupt input as corrupt', () => {
    const node = p.array(p.object({ a: item }).recall()).recall();
    for (const bytes of [new Uint8Array([5]), new Uint8Array([0x40, 1, 1, 1, 1, 1, 1, 1, 1, 1])]) {
      expect(() => node.decode(bytes)).toThrow(CorruptInputError);
    }
  });
});
