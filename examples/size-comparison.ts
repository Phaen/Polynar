/**
 * Size comparison: seven payload shapes encoded as JSON, MessagePack,
 * Protobuf, Avro and Polynar (text and raw bytes), averaged over 250
 * seeded random payloads per row so no single lucky value flatters anyone.
 * Other formats' cells read "plain (brotli)"; Polynar's output is already
 * entropy coded, so its cells read "regular (tuned)" instead: `p.any()`
 * and `p.any().adaptive()` in the self-describing table, and in the schema
 * table the precise node without and with the priors and methods its
 * generator calls for. Prints the two tables from the README: self-describing
 * formats against `p.any()`, which also writes keys and type tags and also
 * gets ascii-safe text to match JSON, and schema formats against the
 * precise Polynar node.
 * Run with: npx tsx examples/size-comparison.ts
 */
import { brotliCompressSync } from 'node:zlib';
import { encode as msgpackEncode } from '@msgpack/msgpack';
import avro from 'avsc';
import protobuf from 'protobufjs';
import { p, CharSets, type AnyValue, type PNode } from 'polynar';

const SAMPLES = 250;

// Seeded, so every run measures the same payloads.
const mulberry32 = (seed: number) => (): number => {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const rand = mulberry32(0x7ab1e);
const randInt = (lo: number, hi: number): number => lo + Math.floor(rand() * (hi - lo + 1));
const pick = <T>(xs: readonly T[]): T => xs[randInt(0, xs.length - 1)];

const NAMES = [
  'Ada Lovelace',
  'Alan Turing',
  'Grace Hopper',
  'Claude Shannon',
  'Kurt Gödel',
  'Emmy Noether',
  'Al-Khwarizmi',
  'Blaise Pascal',
  'Sofia Kovalevskaya',
  'John von Neumann',
  'Katherine Johnson',
  'Edsger Dijkstra',
  'Barbara Liskov',
  'Donald Knuth',
  'Margaret Hamilton',
  'Tim',
  'Jo',
  'Maria Gaetana Agnesi',
];

const SENTENCES = [
  'See you at noon?',
  'ok',
  'Running late, start without me.',
  'Did anyone deploy to staging this morning?',
  'The build is green again, thanks for the quick fix!',
  'Where did we land on the pricing question from yesterday?',
  "I'll take a look after lunch.",
  'Can you resend the link?',
  'That worked, wonderful. Shipping it now.',
  'Meeting moved to Thursday at three, same room as always.',
  'No idea what happened here, the logs stop at midnight and nothing after.',
  'Sounds good 👍',
  'Wait, wrong channel — sorry!',
  'The customer says the export still times out on large accounts.',
  'Happy Friday everyone!',
];

const LOREM_IPSUM =
  'Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor ' +
  'incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud ' +
  'exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat. Duis aute irure ' +
  'dolor in reprehenderit in voluptate velit esse cillum dolore eu fugiat nulla pariatur. ' +
  'Excepteur sint occaecat cupidatat non proident, sunt in culpa qui officia deserunt ' +
  'mollit anim id est laborum.\n\n' +
  'Sed ut perspiciatis unde omnis iste natus error sit voluptatem accusantium doloremque ' +
  'laudantium, totam rem aperiam, eaque ipsa quae ab illo inventore veritatis et quasi ' +
  'architecto beatae vitae dicta sunt explicabo. Nemo enim ipsam voluptatem quia voluptas ' +
  'sit aspernatur aut odit aut fugit, sed quia consequuntur magni dolores eos qui ratione ' +
  'voluptatem sequi nesciunt. Neque porro quisquam est, qui dolorem ipsum quia dolor sit ' +
  'amet, consectetur, adipisci velit, sed quia non numquam eius modi tempora incidunt ut ' +
  'labore et dolore magnam aliquam quaerat voluptatem.\n\n' +
  'At vero eos et accusamus et iusto odio dignissimos ducimus qui blanditiis praesentium ' +
  'voluptatum deleniti atque corrupti quos dolores et quas molestias excepturi sint ' +
  'occaecati cupiditate non provident, similique sunt in culpa qui officia deserunt ' +
  'mollitia animi, id est laborum et dolorum fuga. Et harum quidem rerum facilis est et ' +
  'expedita distinctio.';

/** A grid point of `p.decimal(0.00001)`: the same double the node decodes. */
const gridE5 = (k: number): number => k / 100000;

interface Row {
  label: string;
  /** Rows hold nodes of unrelated value types. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  node: PNode<any>;
  /** The same schema with the priors and methods the generator calls for. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  tuned?: PNode<any>;
  proto: string;
  avro: avro.Schema;
  /**
   * Fresh random payload; `protoValue` when Protobuf needs another shape,
   * `avroValue` when Avro needs yet another, else Avro takes what Protobuf got.
   */
  gen: () => { value: AnyValue; protoValue?: unknown; avroValue?: unknown };
  samples?: number;
}

const ROWS: Row[] = [
  {
    label: 'User profile',
    node: p.object({
      name: p.string().max(40),
      age: p.int().min(0).max(120),
      role: p.enum(['admin', 'member', 'guest']),
      active: p.bool(),
    }),
    tuned: p.object({
      name: p.string().max(40).prose(),
      // Even odds from 16 to 95.
      age: p
        .int()
        .min(0)
        .max(120)
        .cdf((v) => Math.min(Math.max(v - 16, 0), 80)),
      role: p.enum(['admin', 'member', 'guest']).weights([500, 8075, 1425]),
      active: p.bool().weights([4, 1]),
    }),
    proto: `syntax = "proto3";
      message UserProfile {
        string name = 1;
        uint32 age = 2;
        enum Role { MEMBER = 0; ADMIN = 1; GUEST = 2; }
        Role role = 3;
        bool active = 4;
      }`,
    avro: {
      type: 'record',
      name: 'UserProfile',
      fields: [
        { name: 'name', type: 'string' },
        { name: 'age', type: 'int' },
        {
          name: 'role',
          type: { type: 'enum', name: 'Role', symbols: ['admin', 'member', 'guest'] },
        },
        { name: 'active', type: 'boolean' },
      ],
    },
    gen: () => {
      const roles = ['admin', 'member', 'guest'] as const;
      const role = roles[rand() < 0.05 ? 0 : rand() < 0.85 ? 1 : 2];
      const value = {
        name: pick(NAMES),
        age: randInt(16, 95),
        role,
        active: rand() < 0.8,
      };
      return {
        value,
        protoValue: { ...value, role: { member: 0, admin: 1, guest: 2 }[role] },
        avroValue: value,
      };
    },
  },

  {
    label: 'GPS position',
    // Uniform over the bounds, so nothing beyond them applies.
    node: p.object({
      lat: p.decimal(0.00001).min(-90).max(90),
      lng: p.decimal(0.00001).min(-180).max(180),
    }),
    proto: `syntax = "proto3";
      message GpsPosition {
        sint32 lat_e5 = 1;
        sint32 lng_e5 = 2;
      }`,
    avro: {
      type: 'record',
      name: 'GpsPosition',
      fields: [
        { name: 'latE5', type: 'int' },
        { name: 'lngE5', type: 'int' },
      ],
    },
    gen: () => {
      const latE5 = randInt(-9000000, 9000000);
      const lngE5 = randInt(-18000000, 18000000);
      return {
        value: { lat: gridE5(latE5), lng: gridE5(lngE5) },
        protoValue: { latE5, lngE5 },
      };
    },
  },

  {
    label: 'Chat message',
    node: p.object({
      from: p.int().min(0),
      sentAt: p.date(),
      text: p.string().max(500).prose(),
    }),
    // Even ids and timestamps, one sentence per message: nothing beyond
    // `.prose()` applies.
    proto: `syntax = "proto3";
      message ChatMessage {
        uint32 from = 1;
        int64 sent_at = 2;
        string text = 3;
      }`,
    avro: {
      type: 'record',
      name: 'ChatMessage',
      fields: [
        { name: 'from', type: 'int' },
        { name: 'sentAt', type: 'long' },
        { name: 'text', type: 'string' },
      ],
    },
    gen: () => {
      const sentAt = new Date(randInt(1.6e12, 1.8e12));
      const value = { from: randInt(0, 5000), sentAt, text: pick(SENTENCES) };
      return { value, protoValue: { ...value, sentAt: sentAt.getTime() } };
    },
  },

  {
    label: 'Sensor reading',
    node: p.object({
      id: p.int().min(0).max(65535),
      temperature: p.decimal(0.1).min(-40).max(125),
      battery: p.int().min(0).max(100),
      ok: p.bool(),
    }),
    // Only `ok` is skewed; the rest is uniform over its bounds.
    tuned: p.object({
      id: p.int().min(0).max(65535),
      temperature: p.decimal(0.1).min(-40).max(125),
      battery: p.int().min(0).max(100),
      ok: p.bool().weights([19, 1]),
    }),
    proto: `syntax = "proto3";
      message SensorReading {
        uint32 id = 1;
        sint32 temperature_e1 = 2;
        uint32 battery = 3;
        bool ok = 4;
      }`,
    avro: {
      type: 'record',
      name: 'SensorReading',
      fields: [
        { name: 'id', type: 'int' },
        { name: 'temperatureE1', type: 'int' },
        { name: 'battery', type: 'int' },
        { name: 'ok', type: 'boolean' },
      ],
    },
    gen: () => {
      const temperatureE1 = randInt(-400, 1250);
      const value = {
        id: randInt(0, 65535),
        temperature: temperatureE1 / 10,
        battery: randInt(0, 100),
        ok: rand() < 0.95,
      };
      return { value, protoValue: { ...value, temperatureE1 } };
    },
  },

  {
    label: 'Shopping cart',
    node: p
      .array(
        p.object({
          product: p.int().min(0).max(99999),
          qty: p.int().min(1).max(99),
        })
      )
      .max(20),
    tuned: p
      .array(
        p.object({
          product: p.int().min(0).max(99999),
          // 1: 45%, 2: 33%, 3: 11%, the other 11% spread evenly.
          qty: p
            .int()
            .min(1)
            .max(99)
            .weights([4320, 3168, 1056, ...Array<number>(96).fill(11)]),
        })
      )
      .max(20)
      // Even odds from 1 to 8 items.
      .cdf((n) => Math.min(Math.max(n - 1, 0), 8)),
    proto: `syntax = "proto3";
      message ShoppingCart {
        message Item { uint32 product = 1; uint32 qty = 2; }
        repeated Item items = 1;
      }`,
    avro: {
      type: 'array',
      items: {
        type: 'record',
        name: 'Item',
        fields: [
          { name: 'product', type: 'int' },
          { name: 'qty', type: 'int' },
        ],
      },
    },
    gen: () => {
      const qty = (): number =>
        rand() < 0.45 ? 1 : rand() < 0.6 ? 2 : rand() < 0.5 ? 3 : randInt(4, 99);
      const items = Array.from({ length: randInt(1, 8) }, () => ({
        product: randInt(0, 99999),
        qty: qty(),
      }));
      return { value: items, protoValue: { items }, avroValue: items };
    },
  },

  {
    label: 'Status feed',
    node: p.array(p.enum(['ok', 'warn', 'error'])).length(100),
    tuned: p.array(p.enum(['ok', 'warn', 'error']).weights([90, 9, 1])).length(100),
    proto: `syntax = "proto3";
      message StatusFeed {
        enum Status { OK = 0; WARN = 1; ERROR = 2; }
        repeated Status statuses = 1;
      }`,
    avro: {
      type: 'array',
      items: { type: 'enum', name: 'Status', symbols: ['ok', 'warn', 'error'] },
    },
    gen: () => {
      const statuses = Array.from({ length: 100 }, () => {
        const r = rand();
        return r < 0.9 ? 'ok' : r < 0.99 ? 'warn' : 'error';
      });
      return {
        value: statuses,
        protoValue: { statuses: statuses.map((s) => ({ ok: 0, warn: 1, error: 2 })[s]) },
        avroValue: statuses,
      };
    },
  },

  {
    label: 'Lorem ipsum',
    node: p.string().prose(),
    // Free text has no distribution to declare, so it learns.
    tuned: p.string().prose().adaptive(),
    proto: `syntax = "proto3";
      message LoremIpsum {
        string text = 1;
      }`,
    avro: 'string',
    gen: () => ({ value: LOREM_IPSUM, protoValue: { text: LOREM_IPSUM }, avroValue: LOREM_IPSUM }),
    samples: 1,
  },
];

const KEYS = [
  'json',
  'msgpack',
  'anyUrlSafe',
  'anyAsciiSafe',
  'anyBinary',
  'proto',
  'avro',
  'urlSafe',
  'asciiSafe',
  'binary',
] as const;
type Key = (typeof KEYS)[number];
const OTHER: ReadonlySet<Key> = new Set<Key>(['json', 'msgpack', 'proto', 'avro']);
type Cells = Record<Key, string>;
const urlSafe = { type: 'text', charset: CharSets.urlSafe } as const;
const asciiSafe = { type: 'text', charset: CharSets.asciiSafe } as const;

function measure({
  node,
  tuned,
  proto,
  avro: avroSchema,
  gen,
  samples = SAMPLES,
}: Row): Cells {
  const Message = protobuf.parse(proto).root.lookupType(/message (\w+)/.exec(proto)![1]);
  const AvroType = avro.Type.forSchema(avroSchema);
  const any = p.any();
  const anyAdaptive = p.any().adaptive();
  const sums = Object.fromEntries(KEYS.map((k) => [k, 0])) as Record<Key, number>;
  const second = Object.fromEntries(KEYS.map((k) => [k, 0])) as Record<Key, number>;
  const brotli = Object.fromEntries(KEYS.map((k) => [k, 0])) as Record<Key, number>;

  for (let i = 0; i < samples; i++) {
    const { value, protoValue, avroValue } = gen();
    const cells: Record<Key, Uint8Array> = {
      json: Buffer.from(JSON.stringify(value)),
      msgpack: msgpackEncode(value),
      anyUrlSafe: Buffer.from(any.encode(value, urlSafe)),
      anyAsciiSafe: Buffer.from(any.encode(value, asciiSafe)),
      anyBinary: any.encode(value),
      proto: Message.encode(
        Message.fromObject((protoValue ?? value) as Record<string, unknown>)
      ).finish(),
      avro: AvroType.toBuffer(avroValue ?? protoValue ?? value),
      urlSafe: Buffer.from(node.encode(value, urlSafe)),
      asciiSafe: Buffer.from(node.encode(value, asciiSafe)),
      binary: node.encode(value),
    };
    for (const key of KEYS) {
      sums[key] += cells[key].length;
      if (OTHER.has(key)) {
        brotli[key] += brotliCompressSync(cells[key]).length;
      }
    }
    second.anyUrlSafe += anyAdaptive.encode(value, urlSafe).length;
    second.anyAsciiSafe += anyAdaptive.encode(value, asciiSafe).length;
    second.anyBinary += anyAdaptive.encode(value).length;
    const precise = tuned ?? node;
    second.urlSafe += precise.encode(value, urlSafe).length;
    second.asciiSafe += precise.encode(value, asciiSafe).length;
    second.binary += precise.encode(value).length;
  }

  // A single sample is an exact size, not a mean.
  const size = (total: number): string =>
    samples === 1 ? `${total}` : (total / samples).toFixed(1);
  const cell = (key: Key): string =>
    OTHER.has(key)
      ? `${size(sums[key])} (${size(brotli[key])})`
      : `${size(sums[key])} (${size(second[key])})`;
  return Object.fromEntries(KEYS.map((k) => [k, cell(k)])) as Cells;
}

const results = ROWS.map((row) => ({ label: row.label, cells: measure(row) }));

console.log('Self-describing: keys and types travel with the data');
console.table(
  results.map(({ label, cells }) => ({
    Example: label,
    JSON: cells.json,
    MessagePack: cells.msgpack,
    'url-safe': cells.anyUrlSafe,
    'ascii-safe': cells.anyAsciiSafe,
    binary: cells.anyBinary,
  }))
);

console.log('Schema: both sides share the shape');
console.table(
  results.map(({ label, cells }) => ({
    Example: label,
    Protobuf: cells.proto,
    Avro: cells.avro,
    'url-safe': cells.urlSafe,
    'ascii-safe': cells.asciiSafe,
    binary: cells.binary,
  }))
);
