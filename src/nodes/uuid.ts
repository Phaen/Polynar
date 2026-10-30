import { Encoder, Decoder } from '../packer';
import { STRUCT, type CompressOptions } from '../predictor/types';
import type { Kind } from './guards';
import type { AdaptOptions } from './adaptive';
import { members, type Members } from './members';
import { MethodNode, learningOf, type MethodSet } from './methods';
import { describe } from './path';

const STR_MARKERS: ReadonlySet<number> = new Set([STRUCT.STR]);

/** Lowercase 8-4-4-4-12 hex. */
const SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The version nibble's weights: v4 above all, then v1 and v7. */
const VERSION_WEIGHTS = Array.from({ length: 16 }, (_, v) =>
  v === 4 ? 16 : v === 1 || v === 7 ? 4 : 1
);
/** The variant's two top bits: RFC 4122's `10` above the rest. */
const VARIANT_WEIGHTS = [1, 1, 8, 1];

/** The other 122 bits as three digits, most significant first. */
const SPLIT = [41n, 41n, 40n];
const RADICES = SPLIT.map((bits) => 2 ** Number(bits));

/**
 * A UUID string: lowercase 8-4-4-4-12 hex, anything else throwing. The version
 * nibble and the variant bits go through tables that favour v4 and RFC 4122,
 * the other 122 bits as they are. `p.uuid`.
 */
export class PUuid extends MethodNode<string> {
  readonly _kinds: readonly Kind[] = ['string'];
  readonly _compress?: CompressOptions;
  private readonly _version: Members;
  private readonly _variant: Members;

  constructor(readonly _methods: MethodSet = {}) {
    super();
    this._compress = _methods.compress;
    // Under `.compress()` the two tables learn; the bits carry nothing to learn.
    const adapt =
      learningOf(_methods) ??
      (_methods.compress === undefined ? undefined : { separate: _methods.compress.separate });
    this._version = members(16, { weights: VERSION_WEIGHTS, adapt }, 'p.uuid');
    this._variant = members(4, { weights: VARIANT_WEIGHTS, adapt }, 'p.uuid');
  }

  /**
   * Let the version and variant tables learn from the message, starting from
   * their weights. `window` and `separate` as on every `.adapt()`. Not with
   * `.compress()`.
   */
  adapt(options?: AdaptOptions): PUuid {
    return this._declare('adapt', 'p.uuid', options);
  }

  /**
   * The version and variant tables learn, as under `.adapt()`, with the
   * option `separate`; the other bits stay as they are. Not with `.adapt()`.
   */
  compress(options?: CompressOptions): PUuid {
    return this._adapt(options, 'p.uuid');
  }

  _adapted(options: CompressOptions): PUuid {
    return this._adaptedTo(options);
  }

  _withMethods(methods: MethodSet): PUuid {
    return new PUuid(methods);
  }

  _markers(): ReadonlySet<number> {
    return STR_MARKERS;
  }

  _write(enc: Encoder, value: string): void {
    if (typeof value !== 'string' || !SHAPE.test(value)) {
      throw new RangeError(`Value ${describe(value)} is not a lowercase UUID`);
    }
    const hex = value.replace(/-/g, '');
    const version = parseInt(hex[12], 16);
    const nibble = parseInt(hex[16], 16);
    const rest = BigInt(`0x${hex.slice(0, 12)}${hex.slice(13, 16)}${hex.slice(17)}`);
    // The variant nibble's low two bits stay with the rest, above the last 60 bits.
    const bits = ((rest >> 60n) << 62n) | (BigInt(nibble & 3) << 60n) | (rest & ((1n << 60n) - 1n));
    this._version.write(enc, version);
    this._variant.write(enc, nibble >> 2);
    let shift = 122n;
    for (let i = 0; i < SPLIT.length; i++) {
      shift -= SPLIT[i];
      enc.compose(Number((bits >> shift) & ((1n << SPLIT[i]) - 1n)), RADICES[i]);
    }
  }

  _read(dec: Decoder): string {
    const version = this._version.read(dec);
    const variant = this._variant.read(dec);
    let bits = 0n;
    for (let i = 0; i < SPLIT.length; i++) {
      bits = (bits << SPLIT[i]) | BigInt(dec.parse(RADICES[i]));
    }
    const nibble = (variant << 2) | Number((bits >> 60n) & 3n);
    const rest = ((bits >> 62n) << 60n) | (bits & ((1n << 60n) - 1n));
    const hex = rest.toString(16).padStart(30, '0');
    const all = `${hex.slice(0, 12)}${version.toString(16)}${hex.slice(12, 15)}${nibble.toString(16)}${hex.slice(15)}`;
    return `${all.slice(0, 8)}-${all.slice(8, 12)}-${all.slice(12, 16)}-${all.slice(16, 20)}-${all.slice(20)}`;
  }
}
