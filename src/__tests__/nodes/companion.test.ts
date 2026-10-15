/**
 * Companion recall under `p.any().adaptive()`: a key predicted from an
 * earlier one in its record or around it.
 */

import { p, PNode, Encoder, Decoder, type AnyValue } from '../../index';
import { MAX_KEYS } from '../../nodes/any';
import {
  Companion,
  Scope,
  MAX_PAIRS,
  MAX_SCOPE,
  MAX_TEMPLATE,
  Origin,
  template,
} from '../../nodes/companion';
import { mulberry32, trip } from '../support';

const uuid = (random: () => number): string =>
  Array.from({ length: 32 }, () => Math.floor(random() * 16).toString(16)).join('');

/** Users, each with a session and an address of their own. */
const users = (random: () => number, n: number) =>
  Array.from({ length: n }, (_, i) => ({
    user: `u${i}`,
    session: uuid(random),
    ip: `10.0.${Math.floor(random() * 256)}.${Math.floor(random() * 256)}`,
  }));

/** `n` events by those users, each with an id and a duration of its own. */
const events = (seed: number, n: number, linked: boolean): AnyValue[] => {
  const random = mulberry32(seed);
  const people = users(random, 12);
  const pick = () => people[Math.floor(random() * people.length)];
  return Array.from({ length: n }, (_, i) => {
    const who = pick();
    const { session, ip } = linked ? who : pick();
    return { id: i, user: who.user, ms: Math.floor(random() * 1e5), meta: { seq: i, session, ip } };
  });
};

/** `n` repositories, each with a name and urls built from it. */
const repos = (seed: number, n: number) => {
  const random = mulberry32(seed);
  const word = () => Math.floor(random() * 2 ** 32).toString(36);
  return Array.from({ length: n }, (_, id) => {
    const full = `${word()}/${word()}`;
    const url = `https://api.example.com/repos/${full}`;
    return { id, full, url, forks: `${url}/forks`, tags: `${url}/tags{/tag}` };
  });
};

const size = (value: AnyValue) => {
  const node = p.any().adaptive();
  expect(trip(node, value)).toEqual(value);
  return node.encode(value).length;
};

describe('companion recall', () => {
  it('predicts fields that follow an earlier one, in the record or around it', () => {
    const linked = events(1, 300, true);
    const bare = linked.map((row) => ({
      ...(row as object),
      meta: { seq: (row as { id: number }).id },
    }));
    // Past their first spelling, the session and address cost little more than nothing.
    expect(size(linked) - size(bare)).toBeLessThan(330);
    expect(size(linked)).toBeLessThan(size(events(1, 300, false)) - 120);
  });

  it('costs next to nothing on fields that follow nothing', () => {
    const control = events(2, 300, false);
    const shuffled = control.map((row, i) => ({
      ...(row as object),
      user: (control[(i * 7) % 300] as { user: string }).user,
    }));
    expect(Math.abs(size(control) - size(shuffled))).toBeLessThan(40);
  });

  it('predicts a number equal to an earlier sibling', () => {
    const random = mulberry32(3);
    const rows = Array.from({ length: 100 }, () => {
      const n = Math.floor(random() * 1e6);
      return { count: n, label: 'x', total: n };
    });
    const once = rows.map(({ count, label }) => ({ count, label }));
    expect(size(rows) - size(once)).toBeLessThan(30);
  });

  it('predicts from the fields of a recalled record', () => {
    const random = mulberry32(4);
    const paths = ['/', '/docs', '/pricing', '/blog'];
    const rows = Array.from({ length: 200 }, () => {
      const path = paths[Math.floor(random() * paths.length)];
      return { page: { path, ok: true }, url: `https://acme.io${path}`, n: random() };
    });
    const bare = rows.map(({ page, n }) => ({ page, n }));
    expect(size(rows) - size(bare)).toBeLessThan(80);
  });

  it('predicts a value as its previous one with an earlier key swapped in', () => {
    const rows = repos(10, 200);
    const bare = rows.map(({ id, full }) => ({ id, full }));
    // Past their first few rows, the three urls cost a flag each.
    expect(size(rows) - size(bare)).toBeLessThan(150);
  });

  it('swaps in only what changed of an earlier value that its own does not hold', () => {
    const random = mulberry32(11);
    const rows = Array.from({ length: 200 }, () => {
      const user = Math.floor(random() * 2 ** 32).toString(36);
      return { home: `https://x.io/u/${user}/home`, feed: `https://x.io/u/${user}/feed` };
    });
    const bare = rows.map(({ home }) => ({ home }));
    expect(size(rows) - size(bare)).toBeLessThan(60);
  });

  /** `n` events, each sent within a second of when it happened, as ISO strings and timestamps. */
  const sent = (seed: number, n: number) => {
    const random = mulberry32(seed);
    let t = Date.UTC(2026, 0, 1);
    return Array.from({ length: n }, () => {
      t += Math.floor(random() * 6e5);
      const at = t + Math.floor(random() * 900);
      return { t, at, iso: new Date(t).toISOString(), sent: new Date(at).toISOString() };
    });
  };

  it('spells a value as its difference from an earlier sibling, string or number', () => {
    const rows = sent(12, 200);
    // Each send costs about the ten bits of its delay, not its own difference.
    const strings = rows.map(({ iso, sent }) => ({ iso, sent }));
    expect(size(strings) - size(rows.map(({ iso }) => ({ iso })))).toBeLessThan(350);
    const numbers = rows.map(({ t, at }) => ({ t, at }));
    expect(size(numbers) - size(rows.map(({ t }) => ({ t })))).toBeLessThan(300);
    // A value no difference spells, once one is offered, is spelled by its node.
    const odd = [...strings, { iso: strings[0].iso, sent: 'never' }, { iso: 'x', sent: 1.5 }];
    expect(trip(p.any().adaptive(), odd)).toEqual(odd);
    // An earlier value of the same length but no digits spells no difference.
    const words = Array.from({ length: 20 }, (_, i) => ({ w: 'abc', n: `n-${i % 10}` }));
    expect(trip(p.any().adaptive(), words)).toEqual(words);
  });

  it('spells a declared date as its difference from an earlier one', () => {
    const rows = sent(13, 200).map(({ t, at }) => ({ t: new Date(t), at: new Date(at) }));
    const node = p.array(p.object({ t: p.date().adaptive(), at: p.date().adaptive() }).adaptive());
    const bare = p.array(p.object({ t: p.date().adaptive() }).adaptive());
    expect(trip(node, rows)).toEqual(rows);
    expect(node.encode(rows).length - bare.encode(rows).length).toBeLessThan(300);
  });

  it('checks a field spelled as a difference as its node would', () => {
    const random = mulberry32(14);
    const rows = Array.from({ length: 60 }, () => {
      const a = Math.floor(random() * 1e8);
      return { a, b: a + Math.floor(random() * 4) };
    });
    const node = p.array(p.object({ a: p.int(), b: p.int().max(1e8 + 3) }).adaptive());
    expect(trip(node, rows)).toEqual(rows);
    expect(() => node.encode([...rows, { a: 2e8, b: 2e8 + 1 }])).toThrow(RangeError);
  });

  it('takes back a difference a rolled-back write learned', () => {
    const node = p.any().adaptive();
    const rows = sent(15, 120).map(({ iso, sent }) => ({ iso, sent }));
    const enc = new Encoder();
    node._write(enc, rows.slice(0, 60));
    const mark = enc.mark();
    node._write(enc, rows.slice(30));
    enc.rollback(mark);
    node._write(enc, rows.slice(60));
    const plain = new Encoder();
    node._write(plain, rows.slice(0, 60));
    node._write(plain, rows.slice(60));
    expect(enc.output()).toEqual(plain.output());
  });

  it('codes a miss, and values a prediction cannot be, after a prediction set in', () => {
    const rows: AnyValue[] = events(5, 120, true);
    for (let i = 0; i < 60; i++) {
      const { user } = rows[i % 12] as { user: string };
      rows.push({ id: i, user, meta: { session: i % 2 ? { odd: i } : `s${i}`, ip: [i] } });
    }
    expect(trip(p.any().adaptive(), rows)).toEqual(rows);
  });

  it('pairs a key with at most MAX_PAIRS others, the nearest first', () => {
    const random = mulberry32(6);
    const rows = Array.from({ length: 80 }, () => {
      const v = Math.floor(random() * 5);
      const row: Record<string, AnyValue> = { first: v };
      for (let k = 0; k < MAX_PAIRS + 4; k++) row[`f${k}`] = Math.floor(random() * 1e6);
      row.last = v;
      return row;
    });
    const near = rows.map(({ first, ...rest }) => ({ ...rest, near: first, last: first }));
    // `last` only pairs with the nearest keys, so `first` predicts it only once near.
    expect(size(near)).toBeLessThan(size(rows));
  });

  it('keeps no more than MAX_SCOPE values in scope', () => {
    const row = Object.fromEntries(Array.from({ length: MAX_SCOPE + 8 }, (_, i) => [`k${i}`, i]));
    const rows = [row, { ...row }, row];
    expect(trip(p.any().adaptive(), rows)).toEqual(rows);
  });

  it('puts in scope only what a recalled record holds by key, under a key with a companion', () => {
    const late = { flag: true, list: [1], deep: { z: 'q' }, [`k${MAX_KEYS}`]: 'v' };
    const value = {
      ...Object.fromEntries(Array.from({ length: MAX_KEYS }, (_, i) => [`k${i}`, i])),
      a: [late, late, [1], [1]],
    };
    expect(trip(p.any().adaptive(), value)).toEqual(value);
  });

  it('takes back what a rolled-back write learned and left in scope', () => {
    const node = p.any().adaptive();
    const before = events(7, 20, true);
    const tried = [...events(8, 100, true), { [`fresh`]: 'x', id: -1 }];
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
});

describe('template', () => {
  it.each([
    ['https://a.io/x/1', 'x', 'y', 'https://a.io/y/1'],
    ['/issues/12/comments', 12, 1234, '/issues/1234/comments'],
    ['a-b-a', 'a', 'c', 'c-b-c'],
    ['/u/alice/feed', '/u/alice/home', '/u/bob/home', '/u/bob/feed'],
    ['aa', 'a', 'bb', 'bbbb'],
  ])('makes %j with %j as %j into %j', (previous, before, now, made) => {
    expect(template(previous, before, now)).toBe(made);
  });

  it.each([
    ['a value of its own that is no string', 5, 'a', 'b'],
    ['no earlier value', 'ab', undefined, 'b'],
    ['an earlier value that did not change', 'xa', 'a', 'a'],
    ['an earlier value of which it holds no change', 'zzz', 'ab', 'cd'],
    ['an earlier value that was empty', 'abc', '', 'x'],
    ['an earlier value only added to', 'zz', 'ab', 'abc'],
    ['a value of its own too long', 'a'.repeat(MAX_TEMPLATE + 1), 'a', 'b'],
    ['a template too long', 'a'.repeat(100), 'a', 'b'.repeat(20)],
  ])('makes none from %s', (_name, previous, before, now) => {
    expect(template(previous, before, now)).toBeUndefined();
  });
});

/** A number rounded to a whole one, as a node that changes values does. */
class PRounded extends PNode<number> {
  readonly _kinds = ['number'] as const;
  _write(enc: Encoder, value: number): void {
    enc.compose(Math.round(value), 1000);
  }
  _read(dec: Decoder): number {
    return dec.parse(1000);
  }
}

describe('_exact', () => {
  const random = mulberry32(18);
  const pick = <T>(list: readonly T[]): T => list[Math.floor(random() * list.length)];
  const text = () =>
    Array.from({ length: Math.floor(random() * 12) }, () =>
      pick(['a', 'Z', '7', ' ', '-', 'é', '😀', 'the ', '2026-01-01T00:00:00Z', '\n'])
    ).join('');
  const int = () => Math.floor((random() - 0.5) * 2 ** Math.floor(random() * 53));
  const strings = () => Array.from({ length: 60 }, text);
  const ints = () => Array.from({ length: 60 }, int);
  const floats = () =>
    Array.from({ length: 60 }, () =>
      pick([int(), random() * 1e6, (random() - 0.5) * 1e-9, 0.1 + 0.2, Infinity, NaN, int() / 100])
    );
  const words = ['a', 'b', 'c'];

  it.each<[string, PNode<any>, () => unknown[]]>([
    ['p.string()', p.string(), strings],
    ['p.string().adaptive()', p.string().adaptive(), strings],
    ['p.string().prose()', p.string().prose(), strings],
    ['p.string().digits()', p.string().digits(), strings],
    ['p.string().positional()', p.string().positional(), strings],
    ['p.string().delta().adaptive()', p.string().delta().adaptive(), strings],
    ['p.string().repeats()', p.string().repeats(), strings],
    ['p.string().recall()', p.string().recall(), strings],
    ['p.int()', p.int(), ints],
    ['p.int().adaptive()', p.int().adaptive(), ints],
    ['p.int().delta()', p.int().delta(), ints],
    ['p.decimal(0.25)', p.decimal(0.25), () => ints().map((n) => (n % 2 ** 44) * 0.25)],
    [
      'p.decimal(0.01).adaptive()',
      p.decimal(0.01).adaptive(),
      () => ints().map((n) => (n % 1e9) / 100),
    ],
    ['p.float()', p.float(), floats],
    ['p.float().adaptive()', p.float().adaptive(), floats],
    ['p.enum()', p.enum(words), () => strings().map(() => pick(words))],
    ['p.bool()', p.bool(), () => ints().map((n) => n % 2 === 0)],
    ['p.any().adaptive()', p.any().adaptive(), () => [...strings(), ...floats()]],
    ['p.date()', p.date(), () => ints().map((n) => new Date(n % 8.64e15))],
    ['p.date().adaptive()', p.date().adaptive(), () => ints().map((n) => new Date(n % 8.64e15))],
    ['p.optional()', p.optional(p.int()), () => ints().map((n) => (n % 3 === 0 ? undefined : n))],
    ['p.nullable()', p.nullable(p.string()), () => strings().map((s) => (s === '' ? null : s))],
    ['p.union()', p.union([p.int(), p.string()]), () => [...ints(), ...strings()]],
  ])('holds for %s: every value reads back as itself', (_name, node, values) => {
    expect(node._exact).toBe(true);
    const list = values();
    const back = p.array(node).decode(p.array(node).encode(list)) as unknown[];
    back.forEach((value, i) => {
      const was = list[i];
      if (was instanceof Date) {
        expect((value as Date).getTime()).toBe(was.getTime());
      } else {
        expect(Object.is(value, was === 0 ? value : was)).toBe(true);
      }
    });
  });

  it('is off for a node that changes values or that does not say', () => {
    expect(p.date().precision('second')._exact).toBe(false);
    expect(p.optional(p.date().precision('day'))._exact).toBe(false);
    expect(p.union([p.string(), p.date().precision('hour')])._exact).toBe(false);
    expect(new PRounded()._exact).toBe(false);
    expect(p.array(p.int())._exact).toBe(false);
  });
});

describe('predictions of a field whose node changes values', () => {
  const seconds = () => p.date().precision('second').adaptive();
  /** `n` times each sent the same millisecond or up to a second later, at random. */
  const times = (seed: number, n: number) => {
    const random = mulberry32(seed);
    let t = Date.UTC(2026, 0, 1);
    return Array.from({ length: n }, () => {
      t += Math.floor(random() * 6e5);
      return {
        at: new Date(t),
        sent: new Date(random() < 0.5 ? t : t + Math.floor(random() * 900)),
      };
    });
  };
  const floored = (date: Date) => new Date(Math.floor(date.getTime() / 1000) * 1000);

  it('decodes a date as its node would, predicted equal or as a difference', () => {
    const rows = times(16, 150);
    const node = p.array(p.object({ at: seconds(), sent: seconds() }).adaptive());
    const back = node.decode(node.encode(rows));
    expect(back).toEqual(rows.map(({ at, sent }) => ({ at: floored(at), sent: floored(sent) })));
  });

  it.each([
    ['learned', (shape: Record<string, PNode<any>>) => p.object(shape).adaptive()],
    ['declared', (shape: Record<string, PNode<any>>) => p.object(shape).follows({ b: 'a' })],
    [
      'declared and learned',
      (shape: Record<string, PNode<any>>) => p.object(shape).follows({ b: 'a' }).adaptive(),
    ],
  ])('decodes a number as its node would, %s', (_name, object) => {
    const random = mulberry32(17);
    const rows = Array.from({ length: 150 }, () => {
      const a = Math.floor(random() * 50) + 0.4;
      return { a, b: random() < 0.8 ? a : a + 0.2, c: Math.floor(random() * 8) * 0.25 };
    });
    const node = p.array(object({ a: p.float(), b: new PRounded(), c: p.decimal(0.25) }));
    expect(node.decode(node.encode(rows))).toEqual(
      rows.map(({ a, b, c }) => ({ a, b: Math.round(b), c }))
    );
  });
});

describe('Origin', () => {
  it.each([
    ['a safe integer', 12, [12]],
    ['a valid Date', new Date(5), [5]],
    ['a string with digits', 'a07-1234567890123456', [7, 123456789012345, 6]],
  ])('makes one of %s, its fields %j', (_name, value, fields) => {
    expect(Origin.of(value)?.values).toEqual(fields);
  });

  it.each([
    ['a fraction', 1.5],
    ['an invalid Date', new Date(NaN)],
    ['a string without digits', 'abc'],
    ['a string too long', '1'.repeat(MAX_TEMPLATE + 1)],
    ['anything else', true],
  ])('makes none of %s', (_name, value) => {
    expect(Origin.of(value)).toBeUndefined();
  });

  it('spells and builds back a value of its kind', () => {
    const text = Origin.of('id-007/x') as Origin;
    expect(text.bounds(0)).toEqual([0, 999]);
    expect(text.fieldsOf('id-042/x')).toEqual([42]);
    expect(text.build([42])).toBe('id-042/x');
    expect(text.cost([7])).toBe(1);
    const number = Origin.of(-3) as Origin;
    expect(number.bounds(0)).toEqual([-Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER]);
    expect(number.fieldsOf(4)).toEqual([4]);
    expect(number.build([4])).toBe(4);
    const date = Origin.of(new Date(0)) as Origin;
    expect(date.bounds(0)).toEqual([-8.64e15, 8.64e15]);
    expect(date.fieldsOf(new Date(9))).toEqual([9]);
    expect(date.build([9])).toEqual(new Date(9));
  });

  it.each([
    ['a string of another length', 'id-07/x', 'id-0042/x'],
    ['a digit where it has none', 'id-07/x', 'i1-07/x'],
    ['other text between digits', 'id-07/x', 'id_07/x'],
    ['no string', 'id-07/x', 7],
    ['-0', 3, -0],
    ['a number past the safe integers', 3, 2 ** 53],
    ['an invalid Date', new Date(0), new Date(NaN)],
    ['no Date', new Date(0), 0],
  ])('spells no value from %s', (_name, origin, value) => {
    expect((Origin.of(origin) as Origin).fieldsOf(value)).toBeUndefined();
  });
});

describe('Scope', () => {
  it('puts back on a rollback what closing a value took out', () => {
    const scope = new Scope();
    const a = new Companion(scope);
    const enc = new Encoder();
    scope.push(a, 'x');
    const base = scope.open();
    const mark = enc.mark();
    scope.push(a, 'y', enc.journal);
    scope.close(base, enc.journal);
    expect(scope.valueOf(a, null)).toBeNull();
    enc.rollback(mark);
    expect(scope.entries).toEqual([a, 'x']);
    expect(scope.valueOf(a, null)).toBe('x');
  });

  it('sees only the latest value of a key', () => {
    const scope = new Scope();
    const a = new Companion(scope);
    scope.push(a, 'x');
    const base = scope.open();
    scope.push(a, 'y');
    scope.close(base);
    expect(scope.valueOf(a, null)).toBeNull();
  });
});

describe('Companion', () => {
  /** Codes `rows` of two keys, the second following the first, on both sides with `budget` to remember. */
  const run = (budget: number, rows: readonly (readonly [string, string])[]) => {
    const enc = new Encoder();
    const write = new Scope();
    write.budget[0] = budget;
    const [a, b] = [new Companion(write, enc.journal), new Companion(write, enc.journal)];
    const offered: boolean[] = [];
    for (const [x, y] of rows) {
      const base = write.open();
      a.learn(
        a.write(enc, x, () => undefined),
        x,
        enc.journal
      );
      const turn = b.write(enc, y, () => undefined);
      offered.push(turn.offered);
      b.learn(turn, y, enc.journal);
      write.close(base, enc.journal);
    }
    const dec = new Decoder(enc.output());
    const read = new Scope();
    read.budget[0] = budget;
    const [c, d] = [new Companion(read), new Companion(read)];
    for (const [x, y] of rows) {
      const base = read.open();
      c.learn(c.read(dec), x);
      const turn = d.read(dec);
      expect(turn.hit ? turn.prediction : y).toBe(y);
      d.learn(turn, y);
      read.close(base);
    }
    dec.finalize();
    return offered;
  };

  // No template makes one colour from another.
  const colours = ['red', 'green', 'blue', 'gray'];
  const rows = Array.from({ length: 40 }, (_, i) => [`u${i % 4}`, colours[i % 4]] as const);

  it('offers a lookup once it hit twice and saved enough', () => {
    const offered = run(1000, rows);
    expect(offered.slice(0, 8).some(Boolean)).toBe(false);
    expect(offered.slice(-20).every(Boolean)).toBe(true);
  });

  it('remembers nothing past the message budget', () => {
    expect(run(0, rows).some(Boolean)).toBe(false);
  });
});
