# Binary Encoding with Uint8Array

## Overview

Polynar now supports native binary encoding using `Uint8Array`, providing a proper binary output format instead of relying on strings with character codes. This is the **recommended way** to encode data when you need maximum efficiency or are working with binary systems.

## The Problem (Before)

Previously, when using "binary" encoding in Polynar, the output was still a **string** containing characters with specific character codes:

```javascript
const encoder = new Encoder();
encoder.write(42, { type: 'number', min: 0, max: 100 });
const binary = encoder.toString([0, 255]); // Returns a string!
console.log(typeof binary); // "string"
console.log(binary.charCodeAt(0)); // 42
```

**Issues with this approach:**
- ❌ Wrong data type (string instead of binary)
- ❌ Not all character codes are valid/printable
- ❌ JSON serialization problems with non-printable characters
- ❌ Inefficient for binary systems (databases, file storage, network)
- ❌ Confusion about what "binary" encoding actually means

## The Solution (Now)

Use `toUint8Array()` instead of `toString()` for proper binary encoding:

```javascript
const encoder = new Encoder();
encoder.write(42, { type: 'number', min: 0, max: 100 });
const binary = encoder.toUint8Array(); // Returns Uint8Array!
console.log(binary); // Uint8Array(1) [ 42 ]
console.log(typeof binary); // "object"
console.log(binary instanceof Uint8Array); // true
```

**Benefits:**
- ✅ Proper binary data type (`Uint8Array`)
- ✅ Each byte is 0-255 (maximum efficiency)
- ✅ Native JavaScript typed array support
- ✅ Perfect for databases, files, network transmission
- ✅ JSON-serializable via `Array.from(binary)`

## API Changes

### Encoder

**New method added:**
```typescript
toUint8Array(charset?: [number, number]): Uint8Array
```

This method encodes data into a `Uint8Array` with customizable byte range.

**Parameters:**
- `charset` (default: `[0, 255]`) - Byte range as `[min, max]`, same format as string charset ranges.

**Examples:**
```typescript
// Default: full byte range (0-255) - most efficient
encoder.toUint8Array()

// Custom range: printable ASCII (32-126)
encoder.toUint8Array([32, 126])

// Custom range: high bytes only (128-255)
encoder.toUint8Array([128, 255])
```

### Decoder

**Constructor now accepts Uint8Array:**
```typescript
constructor(str: string | Uint8Array, charset?: Charset, strict?: boolean)
```

The decoder automatically detects whether the input is a string or `Uint8Array` and handles it appropriately. The `charset` parameter works the same way for both — pass a `[min, max]` range to restrict the byte range.

**Examples:**
```typescript
// Default range (0-255)
const decoder = new Decoder(uint8Array);

// Custom range matching encoder
const decoder = new Decoder(uint8Array, [32, 126]);

// With strict mode
const decoder = new Decoder(uint8Array, [100, 200], true);
```

## Usage Examples

### Basic Example

```typescript
import { Encoder, Decoder } from 'polynar';

// Encode
const encoder = new Encoder();
encoder.write(42, { type: 'number', min: 0, max: 100 });
const binary = encoder.toUint8Array();

// Decode
const decoder = new Decoder(binary);
const value = decoder.read({ type: 'number', min: 0, max: 100 });
console.log(value); // 42
```

### Complex Data Structures

```typescript
const sensorData = {
  temperature: 23.5,
  humidity: 65,
  active: true,
};

const encoder = new Encoder();
encoder.write(sensorData, {
  type: 'object',
  template: {
    temperature: { type: 'number', min: -50, max: 50, step: 0.1 },
    humidity: { type: 'number', min: 0, max: 100 },
    active: { type: 'boolean' },
  },
});

const binary = encoder.toUint8Array();
// Result: Uint8Array(3) [ 183, 131, 3 ]
// Only 3 bytes vs 41 bytes for JSON!
```

### JSON Serialization

```typescript
// Encode to binary
const encoder = new Encoder();
encoder.write('data', { type: 'string', max: 20 });
const binary = encoder.toUint8Array();

// Convert to JSON-compatible array
const jsonArray = Array.from(binary);
const json = JSON.stringify(jsonArray);
// Store in database, send over API, etc.

// Later: reconstruct from JSON
const reconstructed = new Uint8Array(JSON.parse(json));
const decoder = new Decoder(reconstructed);
const value = decoder.read({ type: 'string', max: 20 });
```

### Custom Byte Ranges

```typescript
import { Encoder, Decoder } from 'polynar';

// Example 1: Printable ASCII only (32-126)
const encoder = new Encoder();
encoder.write('Hello, World!', { type: 'string', max: 50 });

// Encode using only printable ASCII characters as bytes
const printable = encoder.toUint8Array([32, 126]);
console.log('All bytes printable:', printable.every(b => b >= 32 && b <= 126));

// Decode with matching range
const decoder = new Decoder(printable, [32, 126]);
const decoded = decoder.read({ type: 'string', max: 50 });

// Example 2: High byte range (128-255) for specific protocols
const encoder2 = new Encoder();
encoder2.write([1, 2, 3, 4, 5], { type: 'number', min: 0, max: 100 });

const highBytes = encoder2.toUint8Array([128, 255]);
const decoder2 = new Decoder(highBytes, [128, 255]);
const decoded2 = decoder2.read({ type: 'number', min: 0, max: 100 }, 5);

// Example 3: Why use custom ranges?
// - Printable ASCII (32-126): For text-based protocols, debugging
// - High bytes (128-255): Avoid control characters, protocol markers
// - Custom ranges: Match specific protocol requirements
```

## When to Use What

### Use `toUint8Array()` (Binary) When:
- 🗄️ Storing in databases (BLOB, bytea columns)
- 🌐 Transmitting over network (WebSocket binary frames, HTTP body)
- 💾 Saving to files (.bin, .dat files)
- 📊 Maximum space efficiency is critical
- 🔧 Working with binary protocols
- ⚡ Performance is important

### Use `toString()` (String) When:
- 🔗 Embedding in URLs (use `CharSets.urlSafe`)
- 📧 Text-only systems (email, SMS, terminal)
- 👁️ Need human-readable output
- 📝 JSON string fields
- 🔄 Legacy system integration
- 🎨 Specific character set requirements (Base64, hex, etc.)

## Performance Comparison

Example with complex object:

```javascript
const data = { temp: 23.5, humidity: 65, active: true };

// JSON
const json = JSON.stringify(data);
// Size: 41 bytes

// Polynar Binary
const encoder = new Encoder();
encoder.write(data, { /* template */ });
const binary = encoder.toUint8Array();
// Size: 3 bytes

// Compression: 13.67x smaller!
```

## Migration Guide

If you were using binary character ranges before:

**Before:**
```typescript
const encoder = new Encoder();
encoder.write(data, options);
const binary = encoder.toString([0, 255]); // String with char codes
```

**After:**
```typescript
const encoder = new Encoder();
encoder.write(data, options);
const binary = encoder.toUint8Array(); // Proper Uint8Array
```

The `toString([0, 255])` method still works but is **not recommended** for new code. Use `toUint8Array()` instead.

## Implementation Details

- Uses byte range 0-255 (full byte capacity)
- Same polynary encoding algorithm as string version
- Automatically handles all data types (numbers, strings, objects, etc.)
- No charset parameter needed (always uses full byte range)
- Fully backward compatible with existing string encoding

## Testing

Comprehensive tests are included in `src/__tests__/uint8array.test.ts`:
- All data types (numbers, strings, booleans, dates, objects, arrays)
- JSON serialization/deserialization
- Large datasets
- Error handling
- Comparison with string encoding

Run tests: `npm test`

## Examples

See `examples/binary-encoding.ts` for comprehensive examples (after building: `npm run build`).

## Summary

Binary encoding with `Uint8Array` is the **proper way** to work with binary data in Polynar:
- ✅ Correct data type
- ✅ Maximum efficiency
- ✅ Modern JavaScript APIs
- ✅ Perfect for storage and transmission
- ✅ Easy to use

Use it whenever you need true binary encoding!
