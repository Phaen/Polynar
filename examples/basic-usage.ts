/**
 * Basic usage: describe a shape once with `p`, then encode and decode against it.
 * Run with: npx tsx examples/basic-usage.ts
 */
import { p, type Infer } from 'polynar';

// A schema is built once and reused. Each field carries its own constraints, and
// Polynar spends only the bits those constraints allow.
const Player = p.object({
  name: p.string().max(24),
  level: p.int().min(1).max(99),
  alive: p.bool(),
  class: p.enum(['warrior', 'mage', 'rogue']),
  inventory: p.array(p.enum(['sword', 'staff', 'potion', 'rope'])).max(8),
  guild: p.string().optional(),
});

type Player = Infer<typeof Player>;

const ada: Player = {
  name: 'Ada',
  level: 42,
  alive: true,
  class: 'mage',
  inventory: ['staff', 'potion', 'potion'],
};

const bytes = Player.encode(ada);
console.log('encoded into', bytes.length, 'bytes');
console.log('decoded:', Player.decode(bytes));

// Scalars stand on their own.
const temperature = p.float();
console.log('float is bit-exact:', temperature.decode(temperature.encode(21.57)) === 21.57);

// A known step is worth declaring: a price in cents costs 2 bytes, not 8.
const price = p.decimal(0.01).min(0).max(100);
console.log('price round-trip:', price.decode(price.encode(19.99)), 'in', price.encode(19.99).length, 'bytes');

const when = p.date();
const now = new Date();
console.log('date is lossless:', when.decode(when.encode(now)).getTime() === now.getTime());

// An array node batches a column of same-typed values: one validation, one
// encoder, denser output than encoding each value on its own.
const Scores = p.array(p.int().min(0).max(1000));
const scores = [990, 12, 0, 1000, 333];
const packed = Scores.encode(scores);
const oneByOne = scores.reduce((total, s) => total + p.int().min(0).max(1000).encode(s).length, 0);
console.log(`batch is ${packed.length} bytes against ${oneByOne} bytes encoded one at a time`);
console.log('batch decoded:', Scores.decode(packed));
