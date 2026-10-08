/**
 * Schema lazy node (`p.lazy()`) — recursive and forward references.
 */

import { p, type PNode } from '../../index';
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
      replies: p.lazy(() => Thread).optional(),
    });
    const Thread: PNode<Thread> = p.object({ title: p.string(), comments: p.array(Comment) });
    const value: Thread = {
      title: 'launch',
      comments: [{ text: 'first', replies: { title: 're', comments: [{ text: 'second' }] } }],
    };
    expect(trip(Thread, value)).toEqual(value);
  });

  it('is no union member: its kinds are unknown until first use', () => {
    expect(() => p.union([p.lazy(() => p.string()), p.null()])).toThrow('must declare their kinds');
  });
});
