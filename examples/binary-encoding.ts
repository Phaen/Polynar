/**
 * Binary encoding examples using Uint8Array
 *
 * To run these examples:
 * 1. Build the project: npm run build
 * 2. Run with ts-node: npx ts-node examples/binary-encoding.ts
 */

import { Encoder, Decoder, CharSets } from '../dist/esm/index.js';

console.log('=== Binary Encoding with Uint8Array ===\n');

// Example 1: Basic binary encoding
console.log('Example 1: Basic binary encoding');
const encoder1 = new Encoder();
encoder1.write(42, { type: 'number', min: 0, max: 100 });

const stringEncoded = encoder1.toString();
const binaryEncoded = encoder1.toUint8Array();

console.log('String encoding:', stringEncoded);
console.log('String length:', stringEncoded.length, 'chars');
console.log('Binary encoding:', binaryEncoded);
console.log('Binary length:', binaryEncoded.length, 'bytes');
console.log('Binary values:', Array.from(binaryEncoded));

const decoder1 = new Decoder(binaryEncoded);
console.log('Decoded:', decoder1.read({ type: 'number', min: 0, max: 100 }));
console.log();

// Example 2: Complex data structure
console.log('Example 2: Complex data structure');
const sensorData = {
  temperature: 23.5,
  humidity: 65,
  pressure: 1013.25,
  timestamp: new Date('2024-01-15T12:30:00Z'),
  status: 'active',
  alerts: [true, false, false, true],
};

const encoder2 = new Encoder();
encoder2.write(sensorData, {
  type: 'object',
  template: {
    temperature: { type: 'number', min: -50, max: 50, step: 0.1 },
    humidity: { type: 'number', min: 0, max: 100 },
    pressure: { type: 'number', min: 900, max: 1100, step: 0.01 },
    timestamp: { type: 'date', interval: 1000 },
    status: { type: 'item', list: ['active', 'inactive', 'pending', 'error'] },
    alerts: { type: 'boolean', limit: 10 },
  },
});

const jsonString = JSON.stringify(sensorData);
const binaryData = encoder2.toUint8Array();

console.log('Original data:', sensorData);
console.log('JSON size:', jsonString.length, 'bytes');
console.log('Binary size:', binaryData.length, 'bytes');
console.log('Compression ratio:', (jsonString.length / binaryData.length).toFixed(2) + 'x');

const decoder2 = new Decoder(binaryData);
const decoded2 = decoder2.read({
  type: 'object',
  template: {
    temperature: { type: 'number', min: -50, max: 50, step: 0.1 },
    humidity: { type: 'number', min: 0, max: 100 },
    pressure: { type: 'number', min: 900, max: 1100, step: 0.01 },
    timestamp: { type: 'date', interval: 1000 },
    status: { type: 'item', list: ['active', 'inactive', 'pending', 'error'] },
    alerts: { type: 'boolean', limit: 10 },
  },
});

console.log('Decoded data:', decoded2);
console.log();

// Example 3: JSON serialization of binary data
console.log('Example 3: JSON serialization of binary data');
const encoder3 = new Encoder();
encoder3.write('Hello, Binary World!', { type: 'string', max: 50 });

const binary3 = encoder3.toUint8Array();
console.log('Binary:', binary3);

// Convert to JSON-compatible array
const jsonArray = Array.from(binary3);
const jsonSerialized = JSON.stringify(jsonArray);
console.log('JSON serialized:', jsonSerialized);
console.log('JSON size:', jsonSerialized.length, 'bytes');

// Reconstruct from JSON
const reconstructed = new Uint8Array(JSON.parse(jsonSerialized));
const decoder3 = new Decoder(reconstructed);
const decoded3 = decoder3.read({ type: 'string', max: 50 });
console.log('Decoded:', decoded3);
console.log();

// Example 4: Comparison with different encoding methods
console.log('Example 4: Encoding method comparison');
const testData = [1, 2, 3, 4, 5, 10, 20, 30, 40, 50];

const encoder4 = new Encoder();
encoder4.write(testData, { type: 'number', min: 0, max: 100 });

const stringDefault = encoder4.toString();
const stringBase64 = encoder4.toString(CharSets.Base64);
const stringHex = encoder4.toString(CharSets.hex);
const binary4 = encoder4.toUint8Array();

console.log('Default string:', stringDefault.length, 'chars -', stringDefault);
console.log('Base64 string:', stringBase64.length, 'chars -', stringBase64);
console.log('Hex string:', stringHex.length, 'chars -', stringHex);
console.log('Binary (Uint8Array):', binary4.length, 'bytes -', Array.from(binary4));
console.log(
  'Winner: Binary is',
  Math.min(
    stringDefault.length / binary4.length,
    stringBase64.length / binary4.length,
    stringHex.length / binary4.length
  ).toFixed(2) +
    'x more efficient than the best string encoding'
);
console.log();

// Example 5: Large dataset efficiency
console.log('Example 5: Large dataset efficiency');
const largeDataset = Array.from({ length: 1000 }, (_, i) => ({
  id: i,
  value: Math.floor(Math.random() * 100),
  active: Math.random() > 0.5,
}));

const encoder5 = new Encoder();
encoder5.write(largeDataset, {
  type: 'object',
  template: {
    id: { type: 'number', min: 0, max: 10000 },
    value: { type: 'number', min: 0, max: 100 },
    active: { type: 'boolean' },
  },
  limit: 1000,
});

const jsonLarge = JSON.stringify(largeDataset);
const binaryLarge = encoder5.toUint8Array();

console.log('Dataset size:', largeDataset.length, 'items');
console.log('JSON size:', jsonLarge.length, 'bytes');
console.log('Binary size:', binaryLarge.length, 'bytes');
console.log('Space saved:', ((1 - binaryLarge.length / jsonLarge.length) * 100).toFixed(1) + '%');
console.log('Compression ratio:', (jsonLarge.length / binaryLarge.length).toFixed(2) + 'x');
console.log();

// Example 6: When to use binary vs string
console.log('Example 6: Use case recommendations');
console.log(`
Binary encoding (Uint8Array) is best for:
✓ Database storage (BLOB/bytea columns)
✓ Network transmission (WebSocket, HTTP body)
✓ File storage (.bin files)
✓ Maximum space efficiency
✓ Binary protocols

String encoding is best for:
✓ URLs (use urlSafe charset)
✓ Text-only systems (email, SMS)
✓ Human-readable data
✓ JSON compatibility (as string field)
✓ Legacy system integration
`);

console.log('=== All examples completed successfully! ===');
