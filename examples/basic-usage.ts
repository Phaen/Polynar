/**
 * Basic usage examples for Polynar
 *
 * To run these examples:
 * 1. Build the project: npm run build
 * 2. Run with ts-node: npx ts-node examples/basic-usage.ts
 */

import { Encoder, Decoder, CharSets } from '../src';

console.log('=== Polynar Examples ===\n');

// Example 1: Encoding numbers
console.log('Example 1: Number encoding');
const numEncoder = new Encoder();
numEncoder.write(42, { type: 'number', min: 0, max: 100 });
const numEncoded = numEncoder.toString();
console.log('Encoded 42:', numEncoded);

const numDecoder = new Decoder(numEncoded);
const numDecoded = numDecoder.read({ type: 'number', min: 0, max: 100 });
console.log('Decoded:', numDecoded);
console.log();

// Example 2: Encoding strings
console.log('Example 2: String encoding');
const strEncoder = new Encoder();
strEncoder.write('Hello, Polynar!', { type: 'string', max: 50 });
const strEncoded = strEncoder.toString();
console.log('Encoded "Hello, Polynar!":', strEncoded);

const strDecoder = new Decoder(strEncoded);
const strDecoded = strDecoder.read({ type: 'string', max: 50 });
console.log('Decoded:', strDecoded);
console.log();

// Example 3: Encoding multiple booleans
console.log('Example 3: Boolean array encoding');
const boolEncoder = new Encoder();
boolEncoder.write([true, false, true, true, false], { type: 'boolean' });
const boolEncoded = boolEncoder.toString();
console.log('Encoded [true, false, true, true, false]:', boolEncoded);

const boolDecoder = new Decoder(boolEncoded);
const boolDecoded = boolDecoder.read({ type: 'boolean' }, 5);
console.log('Decoded:', boolDecoded);
console.log();

// Example 4: Encoding an object
console.log('Example 4: Object encoding');
const user = {
  name: 'Alice',
  age: 28,
  active: true,
};

const objEncoder = new Encoder();
objEncoder.write(user, {
  type: 'object',
  template: {
    name: { type: 'string', max: 50 },
    age: { type: 'number', min: 0, max: 150 },
    active: { type: 'boolean' },
  },
});
const objEncoded = objEncoder.toString();
console.log('Encoded user object:', objEncoded);

const objDecoder = new Decoder(objEncoded);
const objDecoded = objDecoder.read({
  type: 'object',
  template: {
    name: { type: 'string', max: 50 },
    age: { type: 'number', min: 0, max: 150 },
    active: { type: 'boolean' },
  },
});
console.log('Decoded:', objDecoded);
console.log();

// Example 5: Using different charsets
console.log('Example 5: Different charsets');
const charsetEncoder = new Encoder();
charsetEncoder.write('DATA', { type: 'string', max: 10 });

const base64Result = charsetEncoder.toString(CharSets.Base64);
const urlSafeResult = charsetEncoder.toString(CharSets.urlSafe);
const hexResult = charsetEncoder.toString(CharSets.hex);

console.log('Base64 charset:', base64Result);
console.log('URL-safe charset:', urlSafeResult);
console.log('Hex charset:', hexResult);
console.log();

// Example 6: Encoding from a predefined list
console.log('Example 6: Item list encoding');
const colors = ['red', 'green', 'blue', 'yellow', 'purple'];
const itemEncoder = new Encoder();
itemEncoder.write(['green', 'blue', 'red'], { type: 'item', list: colors });
const itemEncoded = itemEncoder.toString();
console.log('Encoded color selection:', itemEncoded);

const itemDecoder = new Decoder(itemEncoded);
const itemDecoded = itemDecoder.read({ type: 'item', list: colors }, 3);
console.log('Decoded colors:', itemDecoded);
console.log();

// Example 7: Compact representation comparison
console.log('Example 7: Compact representation');
const data = {
  temperature: 23.5,
  humidity: 65,
  timestamp: new Date(),
  status: 'active',
};

// JSON encoding
const jsonEncoded = JSON.stringify(data);
console.log('JSON size:', jsonEncoded.length, 'bytes');
console.log('JSON:', jsonEncoded);

// Polynar encoding
const compactEncoder = new Encoder();
compactEncoder.write(data, {
  type: 'object',
  template: {
    temperature: { type: 'number', min: -50, max: 50, step: 0.1 },
    humidity: { type: 'number', min: 0, max: 100 },
    timestamp: { type: 'date', interval: 1000 },
    status: { type: 'item', list: ['active', 'inactive', 'pending'] },
  },
});
const compactEncoded = compactEncoder.toString();
console.log('Polynar size:', compactEncoded.length, 'bytes');
console.log('Polynar:', compactEncoded);
console.log('Compression ratio:', (jsonEncoded.length / compactEncoded.length).toFixed(2) + 'x');
console.log();

console.log('=== All examples completed successfully! ===');
