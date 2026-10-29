/**
 * `p.lazy()`: recursive and forward references.
 */

import { p, CorruptInputError, type PNode } from '../../index';
import { STRUCT } from '../../predictor/types';
import { trip } from '../support';

type Block =
  | { type: 'paragraph'; text: string }
  | { type: 'list'; ordered: boolean; items: Block[] };

const Block: PNode<Block> = p.tagged('type', {
  paragraph: p.object({ text: p.string() }),
  list: p.object({ ordered: p.bool(), items: p.array(p.lazy(() => Block)) }),
});

describe('Schema lazy', () => {
  it('a schema can contain itself', () => {
    const doc: Block = {
      type: 'list',
      ordered: false,
      items: [
        { type: 'paragraph', text: 'Fruit' },
        {
          type: 'list',
          ordered: true,
          items: [
            { type: 'paragraph', text: 'apples' },
            { type: 'paragraph', text: 'pears' },
          ],
        },
        { type: 'list', ordered: false, items: [] },
      ],
    };
    expect(trip(Block, doc)).toEqual(doc);
  });

  it('costs nothing on the wire', () => {
    const Point = p.object({ x: p.int().min(0).max(9), y: p.int().min(0).max(9) });
    const value = { x: 3, y: 7 };
    expect(p.lazy(() => Point).encode(value)).toEqual(Point.encode(value));
  });

  it('resolves once, on first use', () => {
    let calls = 0;
    const node = p.lazy(() => {
      calls++;
      return p.int().min(0).max(9);
    });
    expect(calls).toBe(0);
    expect(trip(node, 4)).toBe(4);
    expect(trip(node, 5)).toBe(5);
    expect(calls).toBe(1);
  });

  it('a schema can refer to one defined after it', () => {
    type Comment = { text: string; replies?: Thread };
    type Thread = { title: string; comments: Comment[] };
    const Comment: PNode<Comment> = p.object({
      text: p.string(),
      replies: p.optional(p.lazy(() => Thread)),
    });
    const Thread: PNode<Thread> = p.object({ title: p.string(), comments: p.array(Comment) });
    const value: Thread = {
      title: 'launch',
      comments: [{ text: 'first', replies: { title: 're', comments: [{ text: 'second' }] } }],
    };
    expect(trip(Thread, value)).toEqual(value);
  });

  it('takes undefined where its target does', () => {
    expect(p.lazy(() => p.optional(p.int()))._takesUndefined()).toBe(true);
    expect(p.lazy(() => p.int())._takesUndefined()).toBe(false);
  });

  it('is no union member: its kinds are unknown until first use', () => {
    expect(() => p.union([p.lazy(() => p.string()), p.null()])).toThrow('must declare their kinds');
  });

  describe('nesting', () => {
    type Chain = { next?: Chain };
    const Chain: PNode<Chain> = p.object({ next: p.optional(p.lazy(() => Chain)) });
    const chain = (depth: number): Chain => {
      let value: Chain = {};
      for (let i = 0; i < depth; i++) {
        value = { next: value };
      }
      return value;
    };

    it('takes 512 lazy references and refuses one more, a cycle included', () => {
      expect(trip(Chain, chain(512))).toEqual(chain(512));
      const deeper = new RangeError('p.lazy nests deeper than 512 levels');
      expect(() => Chain.encode(chain(513))).toThrow(deeper);
      const cycle: Chain = {};
      cycle.next = cycle;
      expect(() => Chain.encode(cycle)).toThrow(deeper);
    });

    it('refuses input nested deeper than the encoder goes', () => {
      // One more level with the same wire, whose outermost reference is not lazy.
      const Outer = p.object({ next: p.optional(Chain) });
      expect(() => Chain.decode(Outer.encode(chain(513)))).toThrow(
        new CorruptInputError('p.lazy input nests deeper than 512 levels')
      );
    });
  });

  it('refuses a reference that resolves to itself, directly or through others', () => {
    const self: PNode<number> = p.lazy(() => self);
    expect(() => self.encode(1)).toThrow(new TypeError('p.lazy resolves to itself'));
    const a: PNode<number> = p.lazy(() => b);
    const b: PNode<number> = p.lazy(() => a);
    expect(() => a.encode(1)).toThrow(new TypeError('p.lazy resolves to itself'));
    expect(() => b.decode(new Uint8Array())).toThrow(new TypeError('p.lazy resolves to itself'));
  });
});

describe('p.lazy under .adaptive()', () => {
  it('holds adaptive, its target unknown, and speaks for its target', () => {
    const target = p.optional(p.int()).weights([1, 3]).adaptive();
    const node = p.lazy(() => target);
    expect(node._holdsAdaptive).toBe(true);
    expect(p.lazy(() => p.int())._holdsAdaptive).toBe(true);
    expect(node._marker(undefined)).toBe(target._marker(undefined));
    expect(node._marker(2)).toBe(target._marker(2));
    expect(node._markers()).toEqual(target._markers());
    expect(node._markerPrior()).toEqual(target._markerPrior());
    const object = p.lazy(() => p.object({}));
    expect(object._marker({})).toBe(STRUCT.OBJ_START);
    expect(object._markers()).toEqual(new Set([STRUCT.OBJ_START]));
    expect(object._markerPrior()).toBeUndefined();
  });

  it('adapts to a new reference to the adapted target, ending at a cycle', () => {
    type Chain = { next?: Chain };
    const Chain: PNode<Chain> = p.object({ next: p.optional(p.lazy(() => Chain)) });
    const ref = p.lazy(() => Chain);
    const memo = new Map<PNode<any>, PNode<any>>();
    const out = ref._adapted({}, memo);
    expect(out).not.toBe(ref);
    expect(memo.get(ref)).toBe(out);
    expect(out._target._adaptive).toEqual({});
    const value: Chain = { next: { next: { next: {} } } };
    expect(trip(out, value)).toEqual(value);
    expect(memo.get(Chain)).toBe(out._target);
  });

  it('hands the structure symbol its parent coded on to its target', () => {
    const Inner = p.object({ a: p.int(), b: p.optional(p.string()) });
    const Op = p.tagged('kind', { x: p.object({}), y: p.object({ n: p.int() }) });
    const Doc = p.object({
      inner: p.lazy(() => Inner),
      maybe: p.optional(p.lazy(() => Inner)),
      nullable: p.nullable(p.lazy(() => Op)),
      list: p.array(p.lazy(() => p.bool())),
      flag: p.lazy(() => p.bool()),
    });
    const node = Doc.adaptive();
    const values = [
      { inner: { a: 1 }, nullable: null, list: [], flag: true },
      {
        inner: { a: 2, b: 'x' },
        maybe: { a: 3 },
        nullable: { kind: 'y' as const, n: 4 },
        list: [true, false],
        flag: false,
      },
    ];
    for (const value of values) {
      expect(trip(node, value)).toEqual(value);
    }
    expect(trip(p.array(node), values)).toEqual(values);
    expect(
      trip(
        p.lazy(() => node),
        values[1]
      )
    ).toEqual(values[1]);
  });
});
