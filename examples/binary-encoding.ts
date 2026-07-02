/**
 * Binary output: schema encode/decode speak Uint8Array directly, and the
 * lower-level codec lets you pick a custom byte range or a string form.
 * Run with: npx tsx examples/binary-encoding.ts
 */
import { p, Encoder, Decoder, CharSets } from 'polynar';

const Sensor = p.object({
  id: p.int(0, 65535),
  reading: p.int(-40, 125),
  ok: p.bool(),
});

const bytes = Sensor.encode({ id: 4096, reading: 23, ok: true });
console.log('bytes:', Array.from(bytes));
console.log('round-trip:', Sensor.decode(bytes));

// Bytes survive JSON when you need to store or send them as a plain array.
const json = JSON.stringify(Array.from(bytes));
const restored = Sensor.decode(new Uint8Array(JSON.parse(json)));
console.log('via JSON:', restored);

// The lower-level codec exposes the string form and custom byte ranges.
const enc = new Encoder();
enc.write('hello world', { type: 'string', max: 32 });

const asBytes = enc.toUint8Array(); // default byte range [0, 255]
const asPrintable = enc.toUint8Array([32, 126]); // printable ASCII only
const asUrlSafe = enc.toString(CharSets.urlSafe);

console.log('raw bytes:', asBytes.length, 'printable bytes:', asPrintable.length);
console.log('url-safe string:', asUrlSafe);

// Decode each back with the range or charset it was written in.
console.log('from bytes:', new Decoder(asBytes).read({ type: 'string', max: 32 }));
console.log(
  'from printable:',
  new Decoder(asPrintable, [32, 126]).read({ type: 'string', max: 32 })
);
console.log(
  'from url-safe:',
  new Decoder(asUrlSafe, CharSets.urlSafe).read({ type: 'string', max: 32 })
);
