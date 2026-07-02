/**
 * Basic usage: describe a shape once with `p`, then encode and decode against it.
 * Run with: npx tsx examples/basic-usage.ts
 */
import { p, type Infer } from 'polynar';

// A schema is built once and reused. Each field carries its own constraints, and
// Polynar spends only the bits those constraints allow.
const Player = p.object({
  name: p.string().max(24),
  level: p.int(1, 99),
  alive: p.bool(),
  class: p.enum(['warrior', 'mage', 'rogue']),
  guild: p.string().optional(),
});

type Player = Infer<typeof Player>;

const ada: Player = {
  name: 'Ada',
  level: 42,
  alive: true,
  class: 'mage',
};

const bytes = Player.encode(ada);
console.log('encoded into', bytes.length, 'bytes');
console.log('decoded:', Player.decode(bytes));

// Scalars stand on their own.
const temperature = p.float().precision(1e-6);
console.log('float round-trip:', temperature.decode(temperature.encode(21.5)));

const when = p.date();
const now = new Date();
console.log('date is lossless:', when.decode(when.encode(now)).getTime() === now.getTime());

// Batch a column of same-typed values. One validation, one encoder, denser output.
const Score = p.int(0, 1000);
const scores = [990, 12, 0, 1000, 333];
const packed = Score.encodeMany(scores);
const oneByOne = scores.reduce((total, s) => total + Score.encode(s).length, 0);
console.log(`batch is ${packed.length} bytes against ${oneByOne} bytes encoded one at a time`);
console.log('batch decoded:', Score.decodeMany(packed));
