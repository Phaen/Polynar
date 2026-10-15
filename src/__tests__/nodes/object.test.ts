/**
 * `p.object()`: records of named fields. A field whose node takes undefined
 * is optional: a missing key and an undefined value both decode as missing.
 */

import { p, Encoder, type PNode, type PObject } from '../../index';
import { mulberry32, trip } from '../support';

describe('Schema object', () => {
  it("decodes a field named '__proto__' as an own property", () => {
    // Plain assignment would route the value into the prototype setter,
    // dropping the field and leaving the prototype untouched anyway.
    const Schema = p.object({ ['__proto__']: p.int().min(0).max(9) });
    const value = Object.defineProperty({}, '__proto__', {
      value: 5,
      writable: true,
      enumerable: true,
      configurable: true,
    });
    const decoded = Schema.decode(Schema.encode(value as never)) as object;
    expect(Object.getOwnPropertyDescriptor(decoded, '__proto__')?.value).toBe(5);
    expect(Object.getPrototypeOf(decoded)).toBe(Object.prototype);
  });

  it('leaves the key of an undefined optional field out', () => {
    const Person = p.object({ name: p.string(), bio: p.optional(p.string()) });
    expect('bio' in trip(Person, { name: 'Ada', bio: undefined })).toBe(false);
  });

  it.each([
    [
      'a union with an optional member',
      p.object({ f: p.union([p.optional(p.int()), p.string()]) }),
      'a',
    ],
    ['p.any', p.object({ f: p.any() }), [1]],
    ['a versioned optional', p.object({ f: p.versioned(p.optional(p.int())) }), 3],
    ['a lazy optional', p.object({ f: p.lazy(() => p.optional(p.string())) }), 'Ada'],
    [
      'a nullable lazy optional',
      p.object({ f: p.nullable(p.optional(p.lazy(() => p.int()))) }),
      null,
    ],
    [
      'a versioned lazy optional',
      p.object({ f: p.versioned(p.optional(p.lazy(() => p.int()))) }),
      2,
    ],
  ] as [string, PNode<{ f?: unknown }>, unknown][])(
    'takes a missing key on a field of %s',
    (_name, Schema, present) => {
      expect(Object.keys(trip(Schema, { f: undefined }))).toEqual([]);
      expect(Object.keys(trip(Schema, {}))).toEqual([]);
      expect(trip(Schema, { f: present })).toEqual({ f: present });
    }
  );
});

/** `n` events by twelve users, each with a session and an address of its own when `linked`. */
const events = (seed: number, n: number, linked: boolean) => {
  const random = mulberry32(seed);
  const hex = () => Math.floor(random() * 2 ** 32).toString(16);
  const people = Array.from({ length: 12 }, (_, i) => ({
    user: `u${i}`,
    session: hex(),
    ip: `10.0.${Math.floor(random() * 256)}.${Math.floor(random() * 256)}`,
  }));
  const pick = () => people[Math.floor(random() * people.length)];
  return Array.from({ length: n }, (_, i) => {
    const who = pick();
    const { session, ip } = linked ? who : pick();
    const stars = Math.floor(random() * 5000);
    return { id: i, user: who.user, meta: { session, ip }, stars, watchers: stars };
  });
};

type Event = ReturnType<typeof events>[number];

/** The events' schema, adaptive where `adaptive`, and its event object as `shape` makes it. */
const schema = (adaptive: boolean, shape = (o: PObject<any>) => o): PNode<Event[]> => {
  const meta = p.object({ session: p.string().adaptive(), ip: p.string().adaptive() });
  const event = shape(
    p.object({
      id: p.int().min(0).adaptive(),
      user: p.string().adaptive(),
      meta: adaptive ? meta.adaptive() : meta,
      stars: p.int().min(0).adaptive(),
      watchers: p.int().min(0).adaptive(),
    })
  );
  return p.array(adaptive ? event.adaptive() : event).adaptive() as unknown as PNode<Event[]>;
};

const size = <T>(node: PNode<T>, value: T): number => {
  expect(trip(node, value)).toEqual(value);
  return node.encode(value).length;
};

describe('companions of an adaptive object', () => {
  it('predicts fields from earlier ones of the object and of an object around it', () => {
    const linked = events(1, 400, true);
    expect(size(schema(true), linked)).toBeLessThan(size(schema(false), linked) * 0.75);
  });

  it('costs next to nothing on fields that follow nothing', () => {
    const control = events(2, 400, false).map((e, i) => ({ ...e, watchers: i * 7 }));
    expect(size(schema(true), control) - size(schema(false), control)).toBeLessThan(4);
  });

  it('checks a value taken from another field against its own field', () => {
    const Row = p.array(
      p.object({ a: p.int().adaptive(), b: p.int().max(1000).adaptive() }).adaptive()
    );
    const rows = Array.from({ length: 60 }, (_, i) => ({ a: i * 13, b: i * 13 }));
    expect(trip(Row, rows)).toEqual(rows);
    expect(() => Row.encode([...rows, { a: 5000, b: 5000 }])).toThrow(/^\[60\]\.b: /);
  });

  it('decodes -0 as its field does', () => {
    const Row = p.array(
      p.object({ a: p.int().adaptive(), b: p.float().adaptive(), c: p.int().adaptive() }).adaptive()
    );
    const rows = Array.from({ length: 80 }, (_, i) => ({ a: i % 2 ? 0 : -0, b: -0, c: 0 }));
    const back = trip(Row, rows);
    expect(
      back.every(({ a, b, c }) => Object.is(a, 0) && Object.is(b, -0) && Object.is(c, 0))
    ).toBe(true);
  });

  it('predicts from the fields of a recalled object', () => {
    const random = mulberry32(3);
    const pages = ['/', '/docs', '/pricing', '/blog'].map((path) => ({ path, hits: path.length }));
    const rows = Array.from({ length: 200 }, () => {
      const page = pages[Math.floor(random() * pages.length)];
      return { page, url: `https://acme.io${page.path}`, n: random() };
    });
    const Page = p.object({
      path: p.string().adaptive(),
      hits: p.int().adaptive(),
      at: p.optional(p.date()),
    });
    const Row = p.array(
      p
        .object({ page: Page.adaptive(), url: p.string().adaptive(), n: p.float().adaptive() })
        .adaptive()
    );
    const Bare = p.array(p.object({ page: Page.adaptive(), n: p.float().adaptive() }).adaptive());
    expect(
      size(Row, rows) -
        size(
          Bare,
          rows.map(({ page, n }) => ({ page, n }))
        )
    ).toBeLessThan(90);
  });

  it('keeps fields of nested arrays of objects apart, item by item', () => {
    const Leaf = p.object({ k: p.string().adaptive(), v: p.string().adaptive() }).adaptive();
    const Grid = p.array(p.array(Leaf));
    const random = mulberry32(4);
    const grid = Array.from({ length: 20 }, () =>
      Array.from({ length: 6 }, () => {
        const k = `k${Math.floor(random() * 5)}`;
        return { k, v: `${k}!` };
      })
    );
    expect(trip(Grid, grid)).toEqual(grid);
  });

  it('gives no companion to a field that takes no string or number', () => {
    const Row = p.array(
      p.object({ when: p.date(), lazy: p.lazy(() => p.string()), name: p.string() }).adaptive()
    );
    const rows = Array.from({ length: 30 }, (_, i) => ({
      when: new Date(i),
      lazy: 'x',
      name: 'x',
    }));
    expect(trip(Row, rows)).toEqual(rows);
  });

  it('takes back what a rolled-back write learned and left in scope', () => {
    const node = schema(true, (o) => o.recall());
    const before = events(7, 20, true);
    const tried = events(8, 100, true);
    const after = [...events(9, 40, true), ...before.slice(0, 5)];
    const enc = new Encoder();
    node._write(enc, before);
    const mark = enc.mark();
    node._write(enc, tried);
    enc.rollback(mark);
    node._write(enc, after);
    const plain = new Encoder();
    node._write(plain, before);
    node._write(plain, after);
    expect(enc.output()).toEqual(plain.output());
  });
});

describe('p.object().follows()', () => {
  const pinned = (o: PObject<any>) => o.follows({ watchers: 'stars', session: 'user' });
  const starred = (o: PObject<any>) => o.follows({ watchers: 'stars' });

  it('predicts a field from the earlier one it names', () => {
    const Row = p.array(
      pinned(
        p.object({
          user: p.string(),
          session: p.string(),
          stars: p.int().min(0),
          watchers: p.int().min(0),
        })
      )
    );
    const Bare = p.array(
      p.object({
        user: p.string(),
        session: p.string(),
        stars: p.int().min(0),
        watchers: p.int().min(0),
      })
    );
    const rows = events(5, 200, true).map(({ user, meta, stars, watchers }) => ({
      user,
      session: meta.session,
      stars,
      watchers,
    }));
    expect(size(Row, rows)).toBeLessThan(size(Bare, rows) * 0.6);
    // A miss costs the flag and then the value.
    const missed = rows.map((row, i) => ({ ...row, watchers: i }));
    expect(size(Row, missed) - size(Bare, missed)).toBeLessThan((2 * 200) / 8 + 2);
  });

  it('learns its odds under .adaptive(), and keeps the field it names', () => {
    const linked = events(6, 400, true);
    const control = events(6, 400, false).map((e, i) => ({ ...e, watchers: i * 7 }));
    expect(size(schema(true, starred), linked)).toBeLessThan(size(schema(false), linked) * 0.75);
    expect(size(schema(true, starred), control) - size(schema(true), control)).toBeLessThan(12);
  });

  it('predicts a field as its previous value with the one it follows swapped in', () => {
    const random = mulberry32(12);
    const rows = Array.from({ length: 200 }, () => {
      const name = Math.floor(random() * 2 ** 32).toString(36);
      return { name, url: `https://x.io/repos/${name}/forks` };
    });
    const shape = { name: p.string(), url: p.string() };
    const Bare = p.array(p.object(shape));
    for (const Row of [
      p.array(p.object(shape).follows({ url: 'name' })),
      p.array(p.object(shape).follows({ url: 'name' }).adaptive()),
    ]) {
      expect(size(Row, rows)).toBeLessThan(size(Bare, rows) * 0.25);
    }
  });

  it('checks a template against its own field', () => {
    const Rows = p.array(p.object({ a: p.string(), b: p.string().max(6) }).follows({ b: 'a' }));
    const rows = [
      { a: 'ab', b: 'ab!' },
      { a: 'abc', b: 'abc!' },
    ];
    expect(trip(Rows, rows)).toEqual(rows);
    expect(() => Rows.encode([...rows, { a: 'abcdef', b: 'abcdef!' }])).toThrow(RangeError);
  });

  it('takes back what a rolled-back write of a followed field learned', () => {
    const node = schema(true, starred);
    const before = events(7, 20, true);
    const tried = events(8, 100, true);
    const after = events(9, 40, true);
    const enc = new Encoder();
    node._write(enc, before);
    const mark = enc.mark();
    node._write(enc, tried);
    enc.rollback(mark);
    node._write(enc, after);
    const plain = new Encoder();
    node._write(plain, before);
    node._write(plain, after);
    expect(enc.output()).toEqual(plain.output());
  });

  it('codes no flag while the field it follows holds no string or number', () => {
    const Row = p.array(
      p
        .object({ a: p.optional(p.string()), b: p.any() })
        .follows({ b: 'a' })
        .recall()
    );
    const rows = [
      { b: 1 },
      { a: 'x', b: 'x' },
      { a: 'x', b: { y: 1 } },
      { a: 'x', b: 'x' },
      { b: 1 },
    ];
    expect(trip(Row, rows)).toEqual(rows);
  });

  it('checks a value taken from the field it follows against its own field', () => {
    const Row = p.object({ a: p.int(), b: p.int().max(9) }).follows({ b: 'a' });
    expect(trip(Row, { a: 3, b: 3 })).toEqual({ a: 3, b: 3 });
    expect(() => Row.encode({ a: 30, b: 30 })).toThrow(RangeError);
  });

  it.each([
    [{ c: 'a' }, '"c" is not a field'],
    [{ a: 'b' }, '"a" can only follow an earlier field, not "b"'],
    [{ b: 'b' }, '"b" can only follow an earlier field, not "b"'],
    [{ b: 'z' }, '"b" can only follow an earlier field, not "z"'],
  ])('rejects %j', (pins, message) => {
    const Pair = p.object({ a: p.int(), b: p.int() });
    expect(() => Pair.follows(pins as never)).toThrow(message);
  });

  it('rejects a field that already follows one', () => {
    const Trio = p.object({ a: p.int(), b: p.int(), c: p.int() }).follows({ c: 'a' });
    expect(() => Trio.adaptive().follows({ c: 'b' })).toThrow('"c" already follows a field');
    expect(trip(Trio.follows({ b: 'a' }), { a: 1, b: 1, c: 1 })).toEqual({ a: 1, b: 1, c: 1 });
  });
});
