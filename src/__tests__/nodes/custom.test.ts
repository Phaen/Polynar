/**
 * Custom nodes: a `PNode` subclass implements `_write`/`_read` against the
 * packer primitives and composes with the built-in nodes. `_kinds` makes it
 * a union member and decides whether an object field of it takes a missing
 * key.
 */

import { p, PNode, Encoder, Decoder } from '../../index';
import type { CodecOptions } from '../../index';
import { trip } from '../support';

class PRgb extends PNode<[number, number, number]> {
  _write(enc: Encoder, value: [number, number, number]): void {
    for (const channel of value) {
      enc.compose(channel, 256);
    }
  }
  _read(dec: Decoder): [number, number, number] {
    return [dec.parse(256), dec.parse(256), dec.parse(256)];
  }
}

/** Reads one channel more than `PRgb` writes. */
class PRgbOverRead extends PRgb {
  _read(dec: Decoder): [number, number, number] {
    const rgb = super._read(dec);
    dec.parse(256);
    return rgb;
  }
}

class PMaybeWord extends PNode<string | undefined> {
  _write(enc: Encoder, value: string | undefined): void {
    enc.compose(value === undefined ? 0 : 1, 2);
  }
  _read(dec: Decoder): string | undefined {
    return dec.parse(2) === 1 ? 'word' : undefined;
  }
}

describe('Custom nodes', () => {
  it('share one encoder with other nodes and read back in write order', () => {
    const age = p.int().min(0).max(100);
    const name = p.string().max(10);
    const active = p.bool();

    const encoder = new Encoder();
    age._write(encoder, 42);
    name._write(encoder, 'hello');
    active._write(encoder, true);

    const decoder = new Decoder(encoder.output());
    expect(age._read(decoder)).toBe(42);
    expect(name._read(decoder)).toBe('hello');
    expect(active._read(decoder)).toBe(true);
    decoder.finalize();
  });

  it('nest inside the built-in combinators', () => {
    const Palette = p.object({ name: p.string().max(10), colors: p.array(new PRgb()) });
    const value = {
      name: 'sunset',
      colors: [
        [255, 94, 0],
        [255, 195, 113],
      ] as [number, number, number][],
    };
    expect(trip(Palette, value)).toEqual(value);
  });

  it('take a missing key when their kinds are undeclared or include undefined', () => {
    const Schema = p.object({ w: new PMaybeWord() });
    expect(Object.keys(trip(Schema, { w: undefined }))).toEqual([]);
    expect(Object.keys(trip(Schema, {}))).toEqual([]);
    expect(trip(Schema, { w: 'word' })).toEqual({ w: 'word' });

    class PMaybeWordWithKinds extends PMaybeWord {
      readonly _kinds = ['string', 'undefined'] as const;
    }
    expect(Object.keys(trip(p.object({ w: new PMaybeWordWithKinds() }), {}))).toEqual([]);
  });

  it('read 0 when _read reads a value past the last digit', () => {
    const node = new PRgbOverRead();
    const layouts: CodecOptions[] = [{}, { checksum: 8 }, { charset: [0, 99] }];
    for (const options of layouts) {
      const bytes = node.encode([1, 2, 3], options);
      expect(node.decode(bytes, options)).toEqual([1, 2, 3]);
      const text = node.encode([1, 2, 3], { ...options, type: 'text' });
      expect(node.decode(text, options)).toEqual([1, 2, 3]);
    }
  });
});
