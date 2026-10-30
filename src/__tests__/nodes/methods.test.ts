/**
 * Methods: how a node learns, `.adapt(options?)` or `.compress(options?)`,
 * set once and not both, as carried through rebuilds and as a container's
 * `.compress()` reaches the nodes below it.
 */

import { p } from '../../index';
import { loadedPriors } from '../../predictor/prior';
import { learningOf, learns } from '../../nodes/methods';

describe('method set queries', () => {
  it('adapts only with adapt set', () => {
    expect(learns({})).toBe(false);
    expect(learns({ compress: {} })).toBe(false);
    expect(learns({ adapt: true })).toBe(true);
    expect(learns({ adapt: { window: 8 } })).toBe(true);
  });

  it('learns under the options given, the defaults for true, none unless it learns', () => {
    expect(learningOf({})).toBeUndefined();
    expect(learningOf({ compress: {} })).toBeUndefined();
    expect(learningOf({ adapt: true })).toEqual({});
    expect(learningOf({ adapt: { window: 8 } })).toEqual({ window: 8 });
  });
});

describe('.adapt()', () => {
  it('sets the defaults, or a copy of the options given', () => {
    expect(p.bool().adapt()._methods).toEqual({ adapt: true });
    const options = { window: 8 };
    const node = p.bool().adapt(options);
    expect(node._methods).toEqual({ adapt: { window: 8 } });
    expect(node._methods.adapt).not.toBe(options);
  });

  it('is set once', () => {
    expect(() => p.bool().adapt().adapt()).toThrow(new TypeError('p.bool adapt is already set'));
    expect(() => p.array(p.bool()).adapt({ window: 8 }).adapt()).toThrow(
      new TypeError('p.array adapt is already set')
    );
  });

  it('refuses options out of range', () => {
    expect(() => p.bool().adapt({ window: 0 })).toThrow(
      new RangeError('p.bool learning window must be a positive integer, got 0')
    );
  });

  it('refuses a node that adapts already, in either order', () => {
    const both = new TypeError('p.bool adapt and compress cannot both be set');
    expect(() => p.bool().compress().adapt()).toThrow(both);
    expect(() => p.bool().adapt().compress()).toThrow(both);
    expect(() => p.array(p.bool()).compress().adapt()).toThrow(
      new TypeError('p.array adapt and compress cannot both be set')
    );
  });

  it('survives the rebuild a later setting makes', () => {
    const node = p.array(p.bool()).adapt({ window: 8 }).max(5);
    expect(node._methods).toEqual({ adapt: { window: 8 } });
  });
});

describe('.compress() on a leaf', () => {
  it('sets the options once, checked', () => {
    expect(p.bool().compress({ window: 8 })._methods).toEqual({ compress: { window: 8 } });
    expect(p.enum(['a', 'b']).compress()._methods.compress).toBeDefined();
    expect(() => p.bool().compress().compress()).toThrow(
      new TypeError('p.bool compress is already set')
    );
    expect(() => p.enum(['a', 'b']).compress({ candidates: 65 })).toThrow(
      new RangeError('p.enum: compress candidates must be in 0..64, got 65')
    );
  });
});

describe('.compress() on a container', () => {
  const leaf = (node: unknown) => (node as { _methods: object })._methods;

  it('adapts the node and every node below it that neither learns nor adapts', () => {
    const own = p.bool().compress({ window: 8 });
    const learner = p.bool().adapt();
    const node = p.object({ a: p.bool(), b: own, c: learner, d: p.array(p.enum(['x', 'y'])) });
    const adapted = node.compress({ window: 16 });
    const { _shape: shape } = adapted as unknown as { _shape: Record<string, never> };
    expect(leaf(adapted)).toEqual({ compress: { window: 16, prior: loadedPriors.json.source } });
    expect(leaf(shape.a)).toEqual({ compress: { window: 16, prior: loadedPriors.json.source } });
    expect(shape.b).toBe(own);
    expect(shape.c).toBe(learner);
    expect(leaf(shape.d)).toEqual({ compress: { window: 16, prior: loadedPriors.json.source } });
  });

  it('leaves a node that learns, and what is below it, as it is', () => {
    const inner = p.array(p.bool()).adapt();
    const outer = p.array(inner).compress();
    const { _item: item } = outer as unknown as { _item: unknown };
    expect(item).toBe(inner);
  });

  it('keeps a node that adapts or learns under a choice node', () => {
    const compress = p.optional(p.bool()).compress({ window: 8 });
    const learner = p.nullable(p.bool()).adapt();
    expect(p.array(compress).compress()).toBeDefined();
    const list = p.array(learner).compress();
    expect((list as unknown as { _item: unknown })._item).toBe(learner);
    const again = p.array(compress).compress();
    expect((again as unknown as { _item: unknown })._item).toBe(compress);
  });

  it('is set once, and not beside adapt', () => {
    expect(() => p.array(p.bool()).compress().compress()).toThrow(
      new TypeError('p.array compress is already set')
    );
    expect(() => p.object({ a: p.bool() }).compress().compress()).toThrow(
      new TypeError('p.object compress is already set')
    );
    expect(() => p.array(p.bool()).adapt().compress()).toThrow(
      new TypeError('p.array adapt and compress cannot both be set')
    );
  });

  it('refuses options out of range', () => {
    expect(() => p.array(p.bool()).compress({ candidates: 65 })).toThrow(
      new RangeError('p.array: compress candidates must be in 0..64, got 65')
    );
  });

  it('round-trips under the sugar', () => {
    const node = p.array(p.object({ ok: p.bool(), kind: p.enum(['a', 'b']) })).compress();
    const values = Array.from({ length: 30 }, (_, i) => ({
      ok: i % 3 === 0,
      kind: i % 2 === 0 ? ('a' as const) : ('b' as const),
    }));
    expect(node.decode(node.encode(values))).toEqual(values);
  });
});
