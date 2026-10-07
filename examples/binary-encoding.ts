/**
 * Output forms: every node speaks Uint8Array (`encode`/`decode`) and text in a
 * charset of your choice (`encodeString`/`decodeString`). Both byte forms take
 * an optional range when the output has to stay inside one.
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
const asUrlSafe = Message.encodeString('hello world', CharSets.urlSafe);
console.log('url-safe string:', asUrlSafe);
console.log('from url-safe:', Message.decodeString(asUrlSafe, CharSets.urlSafe));

// A [min, max] range restricts which byte values the output may contain.
const asPrintable = Message.encode('hello world', [32, 126]); // printable ASCII only
console.log(
  'printable bytes:',
  asPrintable.length,
  'raw bytes:',
  Message.encode('hello world').length
);
console.log('from printable:', Message.decode(asPrintable, [32, 126]));
