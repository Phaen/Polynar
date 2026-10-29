/**
 * Methods: how a node learns, `.learn(options?)` or `.adaptive(options?)`,
 * set once and not both, as carried through rebuilds and as a container's
 * `.adaptive()` reaches the nodes below it.
 */

import { p } from '../../index';
import { Priors } from '../../predictor/prior';
import { learningOf, learns } from '../../nodes/methods';

describe('method set queries', () => {
  it('learns only with learn set', () => {
    expect(learns({})).toBe(false);
    expect(learns({ adaptive: {} })).toBe(false);
    expect(learns({ learn: true })).toBe(true);
    expect(learns({ learn: { window: 8 } })).toBe(true);
  });

  it('learns under the options given, the defaults for true, none unless it learns', () => {
    expect(learningOf({})).toBeUndefined();
    expect(learningOf({ adaptive: {} })).toBeUndefined();
    expect(learningOf({ learn: true })).toEqual({});
    expect(learningOf({ learn: { window: 8 } })).toEqual({ window: 8 });
  });
});

describe('.learn()', () => {
  it('sets the defaults, or a copy of the options given', () => {
    expect(p.bool().learn()._methods).toEqual({ learn: true });
    const options = { window: 8 };
    const node = p.bool().learn(options);
    expect(node._methods).toEqual({ learn: { window: 8 } });
    expect(node._methods.learn).not.toBe(options);
  });

  it('is set once', () => {
    expect(() => p.bool().learn().learn()).toThrow(new TypeError('p.bool learn is already set'));
    expect(() => p.array(p.bool()).learn({ window: 8 }).learn()).toThrow(
      new TypeError('p.array learn is already set')
    );
  });

  it('refuses options out of range', () => {
    expect(() => p.bool().learn({ window: 0 })).toThrow(
      new RangeError('p.bool learning window must be a positive integer, got 0')
    );
  });

  it('refuses a node that adapts already, in either order', () => {
    const both = new TypeError('p.bool learn and adaptive cannot both be set');
    expect(() => p.bool().adaptive().learn()).toThrow(both);
    expect(() => p.bool().learn().adaptive()).toThrow(both);
    expect(() => p.array(p.bool()).adaptive().learn()).toThrow(
      new TypeError('p.array learn and adaptive cannot both be set')
    );
  });

  it('survives the rebuild a later setting makes', () => {
    const node = p.array(p.bool()).learn({ window: 8 }).max(5);
    expect(node._methods).toEqual({ learn: { window: 8 } });
  });
});

describe('.adaptive() on a leaf', () => {
  it('sets the options once, checked', () => {
    expect(p.bool().adaptive({ window: 8 })._methods).toEqual({ adaptive: { window: 8 } });
    expect(p.enum(['a', 'b']).adaptive()._methods.adaptive).toBeDefined();
    expect(() => p.bool().adaptive().adaptive()).toThrow(
      new TypeError('p.bool adaptive is already set')
    );
    expect(() => p.enum(['a', 'b']).adaptive({ candidates: 65 })).toThrow(
      new RangeError('p.enum: adaptive candidates must be in 0..64, got 65')
    );
  });
});

describe('.adaptive() on a container', () => {
  const leaf = (node: unknown) => (node as { _methods: object })._methods;

  it('adapts the node and every node below it that neither learns nor adapts', () => {
    const own = p.bool().adaptive({ window: 8 });
    const learner = p.bool().learn();
    const node = p.object({ a: p.bool(), b: own, c: learner, d: p.array(p.enum(['x', 'y'])) });
    const adapted = node.adaptive({ window: 16 });
    const { _shape: shape } = adapted as unknown as { _shape: Record<string, never> };
    expect(leaf(adapted)).toEqual({ adaptive: { window: 16, prior: Priors.json.source } });
    expect(leaf(shape.a)).toEqual({ adaptive: { window: 16, prior: Priors.json.source } });
    expect(shape.b).toBe(own);
    expect(shape.c).toBe(learner);
    expect(leaf(shape.d)).toEqual({ adaptive: { window: 16, prior: Priors.json.source } });
  });

  it('leaves a node that learns, and what is below it, as it is', () => {
    const inner = p.array(p.bool()).learn();
    const outer = p.array(inner).adaptive();
    const { _item: item } = outer as unknown as { _item: unknown };
    expect(item).toBe(inner);
  });

  it('keeps a node that adapts or learns under a choice node', () => {
    const adaptive = p.optional(p.bool()).adaptive({ window: 8 });
    const learner = p.nullable(p.bool()).learn();
    expect(p.array(adaptive).adaptive()).toBeDefined();
    const list = p.array(learner).adaptive();
    expect((list as unknown as { _item: unknown })._item).toBe(learner);
    const again = p.array(adaptive).adaptive();
    expect((again as unknown as { _item: unknown })._item).toBe(adaptive);
  });

  it('is set once, and not beside learn', () => {
    expect(() => p.array(p.bool()).adaptive().adaptive()).toThrow(
      new TypeError('p.array adaptive is already set')
    );
    expect(() => p.object({ a: p.bool() }).adaptive().adaptive()).toThrow(
      new TypeError('p.object adaptive is already set')
    );
    expect(() => p.array(p.bool()).learn().adaptive()).toThrow(
      new TypeError('p.array learn and adaptive cannot both be set')
    );
  });

  it('refuses options out of range', () => {
    expect(() => p.array(p.bool()).adaptive({ candidates: 65 })).toThrow(
      new RangeError('p.array: adaptive candidates must be in 0..64, got 65')
    );
  });

  it('round-trips under the sugar', () => {
    const node = p.array(p.object({ ok: p.bool(), kind: p.enum(['a', 'b']) })).adaptive();
    const values = Array.from({ length: 30 }, (_, i) => ({
      ok: i % 3 === 0,
      kind: i % 2 === 0 ? ('a' as const) : ('b' as const),
    }));
    expect(node.decode(node.encode(values))).toEqual(values);
  });
});
