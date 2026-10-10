/**
 * Output forms: every node encodes to a Uint8Array, or to text with
 * `type: 'text'`, and `decode` reads either. Both forms take a charset when the
 * output has to stay inside a set of symbols.
 * Run with: npx tsx examples/binary-encoding.ts
 */
import { p, CharSets } from 'polynar';

const Sensor = p.object({
  id: p.int().min(0).max(65535),
  reading: p.int().min(-40).max(125),
  ok: p.bool(),
});

const bytes = Sensor.encode({ id: 4096, reading: 23, ok: true });
console.log('bytes:', Array.from(bytes));
console.log('round-trip:', Sensor.decode(bytes));

// Bytes survive JSON when you need to store or send them as a plain array.
const json = JSON.stringify(Array.from(bytes));
const restored = Sensor.decode(new Uint8Array(JSON.parse(json)));
console.log('via JSON:', restored);

// Text output picks a charset; both sides must agree on it.
const Message = p.string().max(32);
const asUrlSafe = Message.encode('hello world', { type: 'text', charset: CharSets.urlSafe });
console.log('url-safe string:', asUrlSafe);
console.log('from url-safe:', Message.decode(asUrlSafe, { charset: CharSets.urlSafe }));

// A charset restricts which byte values the output may contain.
const asPrintable = Message.encode('hello world', { charset: [32, 126] }); // printable ASCII only
console.log(
  'printable bytes:',
  asPrintable.length,
  'raw bytes:',
  Message.encode('hello world').length
);
console.log('from printable:', Message.decode(asPrintable, { charset: [32, 126] }));
