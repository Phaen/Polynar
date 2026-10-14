/**
 * Custom types are nodes: subclass PNode, write digits with compose/composeTerm,
 * read them back in the same order with parse/parseTerm. The node then nests
 * inside p.object / p.array and composes with p.optional like any built-in.
 * A node can also spell its values through `members`, the same object the
 * built-ins use for enums, booleans and tags, and so take priors.
 * Run with: npx tsx examples/custom-node.ts
 */
import {
  p,
  PNode,
  Encoder,
  Decoder,
  members,
  type AdaptiveOptions,
  type Infer,
  type MemberPrior,
  type Members,
} from 'polynar';

interface Color {
  r: number;
  g: number;
  b: number;
}

// A color packs each channel into one of 256 members: three bytes' worth of
// state, regardless of output form. All three channels go through one
// `Members`, so under `.adaptive()` they share one table and learn from each
// other.
class PColor extends PNode<Color> {
  private readonly channel: Members;

  constructor(private readonly prior: MemberPrior = {}) {
    super();
    this.channel = members(256, prior, 'PColor');
  }

  adaptive(options?: AdaptiveOptions): PColor {
    return new PColor({ ...this.prior, adaptive: options ?? {} });
  }

  _write(enc: Encoder, value: Color): void {
    if (typeof value !== 'object' || value == null) {
      throw new TypeError('Expected an { r, g, b } object');
    }
    this.channel.write(enc, value.r);
    this.channel.write(enc, value.g);
    this.channel.write(enc, value.b);
  }

  _read(dec: Decoder): Color {
    return { r: this.channel.read(dec), g: this.channel.read(dec), b: this.channel.read(dec) };
  }
}

const color = (): PColor => new PColor();

// The custom node composes with everything the built-ins do.
const Theme = p.object({
  name: p.string().max(20),
  background: color(),
  accents: p.array(color()).max(4),
  overlay: p.optional(color()),
});

// A palette of greys: every channel is one of a few levels, which an
// adaptive table learns over the message.
const Palette = p.array(color().adaptive()).max(64);
const greys = Array.from({ length: 64 }, (_, i) => {
  const level = [0, 128, 255][i % 3];
  return { r: level, g: level, b: level };
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

console.log('packed', greys.length, 'greys into', Palette.encode(greys).length, 'bytes');
