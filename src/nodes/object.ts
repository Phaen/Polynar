import { Encoder, Decoder, ReplayDecoder, SlotCache } from '../packer';
import type { InferShape } from './infer';
import { PNode } from './base';
import { atPath, describe } from './path';
import type { Kind } from './guards';
import { recallOf, withMethod, type Spelling } from './methods';
import { copy, identity, unmeasured, type Recall } from './recall';
import { Companion, Follow, Scope } from './companion';

/**
 * The fields of a message's objects that companions are predicted from:
 * one scope for every adaptive object, so a nested object's fields stay in
 * it for its parent's later ones. An object that begins in the same field
 * write as the one that ended last, the next item of an array, first takes
 * that one's fields out again.
 */
interface Fields {
  readonly scope: Scope;
  /** The field write running now, numbered from 1; 0 outside every adaptive object. */
  field: number;
  /** How many field writes began in the message. */
  fields: number;
  /** The field write the object that ended last ran in, and where its fields began in the scope. */
  last: number;
  base: number;
}

/** The key of every message's `Fields`. */
const FIELDS = {};

/** One object's state in a message, per field: its learned companion and its declared one. */
interface Message {
  /** Under `.adaptive()`, for a field that takes strings, numbers or dates. */
  readonly companions: readonly (Companion | undefined)[];
  /** For a field that `.follows()` another. */
  readonly follows: readonly (Follow | undefined)[];
}

/** `value` as companions learn it: 0 for -0, which ints and decimals decode as 0. */
const learned = (value: unknown): unknown => (value === 0 ? 0 : value);

/**
 * What `field` reads back of `v`, a value it takes: written alone and read
 * back off the log when a companion may predict or learn it, a string,
 * number or Date, so a node that rounds, floors or otherwise changes
 * values is predicted on what it decodes; `v` itself for any other value
 * or an `_exact` field. Throws whatever writing it throws, where it does.
 */
function canonical(field: PNode<any>, v: unknown): unknown {
  if (!scoped(v) || field._exact) {
    return v;
  }
  return unmeasured(() => {
    const trial = new Encoder();
    field._write(trial, v);
    return field._read(new ReplayDecoder(trial));
  });
}

/** Whether `value` joins the scope. */
const scoped = (value: unknown): boolean =>
  typeof value === 'string' || typeof value === 'number' || value instanceof Date;

/**
 * Object with a fixed shape. A field whose node takes `undefined` may be
 * absent or `undefined`, and then decodes with its key left out.
 */
export class PObject<S extends Record<string, PNode<any>>> extends PNode<InferShape<S>> {
  readonly _kinds: readonly Kind[] = ['object'];

  private readonly _shape: S;
  private readonly _keys: readonly string[];
  private readonly _spelling: Spelling;
  /** Set by `.adaptive()`. */
  private readonly _adaptive: boolean;
  /** Set by `.recall()` or `.adaptive()`: learned under `.adaptive()`. */
  private readonly _recall?: Recall<InferShape<S>>;
  /** Set by `.follows()`: per field, the index of the field it follows. */
  private readonly _leaders?: readonly (number | undefined)[];
  private readonly _fields = new SlotCache<Fields, Encoder | Decoder>(FIELDS, () => ({
    scope: new Scope(),
    field: 0,
    fields: 0,
    last: -1,
    base: 0,
  }));
  private readonly _messages = new SlotCache<Message, Encoder | Decoder>(this, (side) => {
    const { scope } = this._fields.get(side);
    const { journal } = side;
    const adaptive = this._adaptive;
    const leaders = this._leaders;
    return {
      companions: this._keys.map((key) => {
        const kinds = this._shape[key]._kinds;
        return adaptive &&
          kinds !== undefined &&
          (kinds.includes('string') || kinds.includes('number') || kinds.includes('date'))
          ? new Companion(scope, journal)
          : undefined;
      }),
      follows: this._keys.map((_, i) =>
        leaders?.[i] === undefined ? undefined : new Follow(scope.budget, adaptive, journal)
      ),
    };
  });

  constructor(
    shape: S,
    spelling: Spelling = {},
    adaptive = false,
    leaders?: readonly (number | undefined)[]
  ) {
    super();
    this._shape = { ...shape }; // copy so later caller mutation can't change the node
    this._keys = Object.keys(this._shape);
    this._spelling = spelling;
    this._adaptive = adaptive;
    this._recall = recallOf(spelling, adaptive ? {} : undefined, copy);
    this._leaders = leaders;
  }

  /**
   * Let the object learn from the message. An object this node already
   * wrote is recalled as under `.recall()`, at learned odds: whether the
   * object is new or seen, and for a seen one, which, by how often each
   * came back, so objects that keep recurring cost a bit or two and ones
   * that never do soon cost next to nothing more than their fields. A
   * string or number field learns which earlier field of this object, of
   * an adaptive object it sits in, or of the last item before it predicts
   * it, as under `.follows()`, and once that has paid off codes a learned
   * flag ahead of its value. A field that `.follows()` keeps the field it
   * names, at learned odds. The fields learn by their own `.adaptive()`.
   * Part of the wire format.
   */
  adaptive(): PObject<S> {
    return new PObject<S>(this._shape, this._spelling, true, this._leaders);
  }

  /**
   * Spell an object this node already wrote in the message by its place
   * among the distinct objects it wrote, and a new one as an escape and
   * then in full: with n objects seen, a repeat costs log2(n + 1) bits, or
   * under `.adaptive()` less the more often it recurs. The message's first
   * object costs nothing extra. Objects the schema writes the same way are
   * the same object, and a repeat decodes as a copy of the object first
   * decoded.
   */
  recall(): PObject<S> {
    const spelling = withMethod(this._spelling, 'recall', 'p.object');
    return new PObject<S>(this._shape, spelling, this._adaptive, this._leaders);
  }

  /**
   * Predict each field named in `pins` from the earlier field it maps to:
   * while that one holds a string or number, a flag comes first, and on a
   * hit the field is the value it had the last time that field had this
   * value in the message, or, that value being new, that field's value
   * itself. The flag costs a bit, or under `.adaptive()` learned odds, and
   * a miss is the flag and then the value as before.
   */
  follows(pins: { readonly [K in keyof S]?: keyof S & string }): PObject<S> {
    const keys = this._keys;
    const leaders = this._leaders?.slice() ?? keys.map(() => undefined);
    for (const key of Object.keys(pins)) {
      const leader = pins[key] as string;
      const at = keys.indexOf(key);
      const from = keys.indexOf(leader);
      if (at < 0) {
        throw new TypeError(`p.object follows: ${describe(key)} is not a field of the shape`);
      }
      if (from < 0 || from >= at) {
        throw new TypeError(
          `p.object field ${describe(key)} can only follow an earlier field, not ${describe(leader)}`
        );
      }
      if (leaders[at] !== undefined) {
        throw new TypeError(`p.object field ${describe(key)} already follows a field`);
      }
      leaders[at] = from;
    }
    return new PObject<S>(this._shape, this._spelling, this._adaptive, leaders);
  }

  /** Whether the shape declares `key`. */
  _has(key: string): boolean {
    return Object.prototype.hasOwnProperty.call(this._shape, key);
  }

  _write(enc: Encoder, value: InferShape<S>): void {
    const recall = this._recall;
    if (!this._adaptive) {
      const message = this._leaders === undefined ? undefined : this._messages.get(enc);
      if (recall === undefined) {
        this._spell(enc, value, message);
      } else {
        const key = () => identity((alone) => this._spell(alone, value));
        recall.write(enc, key, () => this._spell(enc, value, message));
      }
      return;
    }
    this._scoped(enc, (message) => {
      let spelled = false;
      const key = () => identity((alone) => this._spell(alone, value));
      (recall as Recall<InferShape<S>>).write(enc, key, () => {
        // Spelled on a try the recall may take back.
        if (enc.journal.active) {
          enc.journal.call(() => {
            spelled = false;
          });
        }
        spelled = true;
        this._spell(enc, value, message);
      });
      if (!spelled) {
        this._recalled(enc, value, message);
      }
    });
  }

  _read(dec: Decoder): InferShape<S> {
    const recall = this._recall as Recall<InferShape<S>>;
    if (!this._adaptive) {
      const message = this._leaders === undefined ? undefined : this._messages.get(dec);
      return this._recall === undefined
        ? this._unspell(dec, message)
        : recall.read(dec, () => this._unspell(dec, message));
    }
    return this._scoped(dec, (message) => {
      let spelled = false;
      const value = recall.read(dec, () => {
        spelled = true;
        return this._unspell(dec, message);
      });
      if (!spelled) {
        this._recalled(dec, value, message);
      }
      return value;
    });
  }

  /**
   * Runs `code`, the coding of an object under `.adaptive()`, with this
   * object's state in the message, and leaves what it added to the scope
   * there for the fields that follow, until the next object to begin in
   * the same field write takes it out.
   */
  private _scoped<T>(side: Encoder | Decoder, code: (message: Message) => T): T {
    const fields = this._fields.get(side);
    const { scope, field } = fields;
    const { journal } = side;
    if (fields.last === field) {
      scope.close(fields.base, journal);
    }
    const base = scope.open();
    const result = code(this._messages.get(side));
    if (journal?.active === true) {
      journal.set(fields, 'last', fields.last);
      journal.set(fields, 'base', fields.base);
    }
    fields.last = field;
    fields.base = base;
    return result;
  }

  /** Puts the strings and numbers of `value`, a recalled object, in the scope as if coded one by one. */
  private _recalled(side: Encoder | Decoder, value: InferShape<S>, message: Message): void {
    const { scope } = this._fields.get(side);
    const keys = this._keys;
    const { companions } = message;
    for (let i = 0; i < keys.length; i++) {
      const companion = companions[i];
      const raw = (value as Record<string, unknown>)[keys[i]];
      if (companion !== undefined && scoped(raw)) {
        // The decoder's copy is what the field decoded.
        const v = side instanceof Encoder ? canonical(this._shape[keys[i]], raw) : raw;
        scope.push(companion, learned(v), side.journal);
      }
    }
  }

  /** Writes the object in full, through its fields' companions when given its state. */
  private _spell(enc: Encoder, value: InferShape<S>, message?: Message): void {
    const keys = this._keys;
    const fields = this._adaptive && message !== undefined ? this._fields.get(enc) : undefined;
    const field = fields?.field;
    let i = 0;
    try {
      for (; i < keys.length; i++) {
        if (fields !== undefined) {
          fields.field = ++fields.fields;
        }
        this._writeField(enc, value, i, message);
      }
    } catch (error) {
      throw atPath(error, keys[i]);
    } finally {
      if (fields !== undefined) {
        fields.field = field as number;
      }
    }
  }

  /** Writes field `i`. */
  private _writeField(enc: Encoder, value: InferShape<S>, i: number, message?: Message): void {
    const record = value as Record<string, unknown>;
    const field = this._shape[this._keys[i]];
    const v = record[this._keys[i]];
    // A field that takes `undefined` (an optional, or a union or `any` that
    // includes it) writes it like any other value, so an absent key and an
    // `undefined` value encode the same way.
    if (v === undefined && !field._takesUndefined()) {
      throw new TypeError('Required field is missing');
    }
    if (message === undefined) {
      field._write(enc, v);
      return;
    }
    const { journal } = enc;
    const companion = message.companions[i];
    const follow = message.follows[i];
    if (follow === undefined && companion === undefined) {
      field._write(enc, v);
      return;
    }
    // Predictions are made, matched and learned on what the decoder gets.
    const canon = canonical(field, v);
    const learnedValue = learned(canon);
    if (follow !== undefined) {
      const at = this._leaders?.[i] as number;
      const leader = learned(canonical(this._shape[this._keys[at]], record[this._keys[at]]));
      const turn = follow.write(enc, leader, canon);
      if (!turn.hit) {
        field._write(enc, v);
      } else if (turn.kind !== 0 && field._exact) {
        // A value the field may not have had is checked as the field would.
        field._write(new Encoder(), v);
      }
      follow.learn(leader, learnedValue, journal);
      if (companion !== undefined && scoped(learnedValue)) {
        this._fields.get(enc).scope.push(companion, learnedValue, journal);
      }
    } else {
      const turn = (companion as Companion).write(enc, canon, () => field._write(enc, v));
      if (turn.hit && turn.fresh && field._exact) {
        field._write(new Encoder(), v);
      }
      (companion as Companion).learn(turn, learnedValue, journal);
    }
  }

  /** Reads an object `_spell` wrote. */
  private _unspell(dec: Decoder, message?: Message): InferShape<S> {
    const value: Record<string, unknown> = {};
    const keys = this._keys;
    const fields = this._adaptive && message !== undefined ? this._fields.get(dec) : undefined;
    const field = fields?.field;
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      const node = this._shape[key];
      if (fields !== undefined) {
        fields.field = ++fields.fields;
      }
      const v = message === undefined ? node._read(dec) : this._readField(dec, value, i, message);
      if (v === undefined) {
        continue;
      }

      // A schema key named '__proto__' must land as an own property; plain
      // assignment would hit the prototype setter and silently drop it.
      if (key === '__proto__') {
        Object.defineProperty(value, key, {
          value: v,
          writable: true,
          enumerable: true,
          configurable: true,
        });
      } else {
        value[key] = v;
      }
    }
    if (fields !== undefined) {
      fields.field = field as number;
    }
    return value as InferShape<S>;
  }

  /** Reads field `i` of `value`, the object read so far, as `_writeField` wrote it. */
  private _readField(
    dec: Decoder,
    value: Record<string, unknown>,
    i: number,
    message: Message
  ): unknown {
    const node = this._shape[this._keys[i]];
    const companion = message.companions[i];
    const follow = message.follows[i];
    if (follow !== undefined) {
      const leader = learned(value[this._keys[this._leaders?.[i] as number]]);
      const turn = follow.read(dec, leader);
      const v = turn.hit ? turn.prediction : node._read(dec);
      const learnedValue = learned(v);
      follow.learn(leader, learnedValue);
      if (companion !== undefined && scoped(learnedValue)) {
        this._fields.get(dec).scope.push(companion, learnedValue);
      }
      return v;
    }
    if (companion !== undefined) {
      const turn = companion.read(dec);
      const v = turn.hit ? turn.prediction : node._read(dec);
      companion.learn(turn, learned(v));
      return v;
    }
    return node._read(dec);
  }
}
