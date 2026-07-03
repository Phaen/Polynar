/**
 * Custom types are nodes: subclass PNode, write digits with compose/composeTerm,
 * read them back in the same order with parse/parseTerm. The node then nests
 * inside p.object / p.array and gets .optional() like any built-in.
 * Run with: npx tsx examples/custom-node.ts
 */
import { p, PNode, Encoder, Decoder, type Infer } from 'polynar';

interface Color {
  r: number;
  g: number;
  b: number;
}

// A color packs each channel into one base-256 slot: three bytes' worth of
// state, regardless of output form.
class PColor extends PNode<Color> {
  _write(enc: Encoder, value: Color): void {
    if (typeof value !== 'object' || value == null) {
      throw new TypeError('color: expected an { r, g, b } object');
    }
    enc.compose(value.r, 256);
    enc.compose(value.g, 256);
    enc.compose(value.b, 256);
  }

  _read(dec: Decoder): Color {
    return { r: dec.parse(256), g: dec.parse(256), b: dec.parse(256) };
  }
}

const color = (): PColor => new PColor();

// The custom node composes with everything the built-ins do.
const Theme = p.object({
  name: p.string().max(20),
  background: color(),
  accents: p.array(color()).max(4),
  overlay: color().optional(),
});

type Theme = Infer<typeof Theme>;

const dark: Theme = {
  name: 'midnight',
  background: { r: 16, g: 18, b: 27 },
  accents: [
    { r: 255, g: 94, b: 0 },
    { r: 0, g: 200, b: 255 },
  ],
};

const bytes = Theme.encode(dark);
console.log('packed theme into', bytes.length, 'bytes');
console.log('decoded:', Theme.decode(bytes));
