/**
 * `p.any().compress()` (spec §3, the `p.any` row): a value as one stream of structure symbols,
 * key text, strings and numbers through the predictor, every value at its key path within the
 * `p.any` node: `/k` for an object key, `/*` for an array or set item and a map key, `/*\/` for a
 * map value, `''` at the root. A value's first structure symbol is coded at the enclosing
 * container's path, the root's at the root path; a container's keys, items and end at its own.
 * The nodes' plain bodies and the hints come from the `p.any` node through `AnyCoding`; nothing
 * here knows a node.
 */

import type { Decoder, Encoder } from '../packer';
import { CorruptInputError } from '../packer/errors';
import type { PlainNumber, Session } from './session';
import { STRUCT } from './types';
import type { Ends, Resolved } from './types';

/** One kind's plain body: what follows its structure symbol. */
export interface AnyBody {
  write(enc: Encoder, value: unknown): void;
  read(dec: Decoder): unknown;
}

/** What the `p.any` node hands the stream. */
export interface AnyCoding {
  /** The node, whose session state and hint step are keyed by it. */
  readonly node: object;
  readonly o: Resolved;
  /** The plain spelling an integer past the number predictor's classes falls back on. */
  readonly int: PlainNumber;
  /** The plain bodies of BIGINT, REGEXP, BUFFER, DATAVIEW and TYPED_0.., by symbol. */
  readonly bodies: ReadonlyMap<number, AnyBody>;
  /** The number of hints. */
  readonly hints: number;
  /** The first structure symbol of `value`, HINT when a hint takes it; throws for a value `p.any` cannot encode. */
  symbol(enc: Encoder, value: unknown): number;
  /** The index of the hint that takes `value`, which `symbol` named HINT. */
  hint(enc: Encoder, value: unknown): number;
  /** Writes `value` through hint `i`, outside every marker scope. */
  writeHint(enc: Encoder, i: number, value: unknown): void;
  readHint(dec: Decoder, i: number): unknown;
  /** Runs `code` one container deeper, refusing past the depth limit. */
  nest<T>(side: Encoder | Decoder, code: () => T): T;
  /** `error` located at `segment`. */
  at(error: unknown, segment: string | number): unknown;
}

/** Key text and string values: any length, ended by END. */
const TEXT: Ends = { min: 0, max: undefined, fixed: false };

const OBJ_END = { end: STRUCT.OBJ_END, allow: true };
const ARR_END = { end: STRUCT.ARR_END, allow: true };
const SET_END = { end: STRUCT.SET_END, allow: true };
const MAP_END = { end: STRUCT.MAP_END, allow: true };

/** The code points of `text`, a lone surrogate as its code unit. */
const codePoints = (text: string): number[] =>
  Array.from(text, (ch) => ch.codePointAt(0) as number);

/** The string of `cps`. */
function fromCodePoints(cps: ArrayLike<number>): string {
  let text = '';
  for (let i = 0; i < cps.length; i++) text += String.fromCodePoint(cps[i]);
  return text;
}

/** A number that is no safe integer as its shortest round-trip text; -0 keeps its sign. */
const numberText = (x: number): string => (Object.is(x, -0) ? '-0' : String(x));

/** Writes `value` of `p.any().compress()`, its first structure symbol included. */
export function walkAny(s: Session, enc: Encoder, a: AnyCoding, value: unknown): void {
  let sym = s.take(a.node);
  if (sym < 0) {
    sym = a.symbol(enc, value);
    s.marker('', a.o).write(enc, sym);
  }
  writeBody(s, enc, a, value, '', sym);
}

/** Reads a value `walkAny` wrote. */
export function readAny(s: Session, dec: Decoder, a: AnyCoding): unknown {
  let sym = s.take(a.node);
  if (sym < 0) {
    sym = s.marker('', a.o).read(dec);
  }
  return readBody(s, dec, a, '', sym);
}

/** Writes `child` of a container at `path` under its symbol, coded at the container's path. */
function writeChild(
  s: Session,
  enc: Encoder,
  a: AnyCoding,
  path: string,
  child: unknown,
  childPath: string,
  bound?: { end: number; allow: boolean }
): void {
  const sym = a.symbol(enc, child);
  s.marker(path, a.o).write(enc, sym, undefined, bound);
  writeBody(s, enc, a, child, childPath, sym);
}

function writeBody(
  s: Session,
  enc: Encoder,
  a: AnyCoding,
  value: unknown,
  path: string,
  sym: number
): void {
  const o = a.o;
  switch (sym) {
    case STRUCT.STR: {
      const cps = codePoints(value as string);
      s.string(path, o, 'text').write(enc, cps, cps.length, TEXT);
      return;
    }
    case STRUCT.INT:
      s.number(path, o, {}, a.int).write(enc, value as number);
      return;
    case STRUCT.DATE:
      s.number(path, o, {}, a.int).write(enc, (value as Date).getTime());
      return;
    case STRUCT.NUM: {
      const cps = codePoints(numberText(value as number));
      s.text(path, o, 'text').write(enc, cps, cps.length, TEXT);
      return;
    }
    case STRUCT.TRUE:
    case STRUCT.FALSE:
    case STRUCT.NULL:
    case STRUCT.UNDEFINED:
      return;
    case STRUCT.HINT: {
      const i = a.hint(enc, value);
      s.step([a.node, 1], o, a.hints).write(enc, i);
      a.nest(enc, () => a.writeHint(enc, i, value));
      return;
    }
    case STRUCT.OBJ_START:
      a.nest(enc, () => writeObject(s, enc, a, value as Record<string, unknown>, path));
      return;
    case STRUCT.ARR_START:
      a.nest(enc, () => writeItems(s, enc, a, value as unknown[], path, ARR_END));
      return;
    case STRUCT.SET_START:
      a.nest(enc, () => writeItems(s, enc, a, [...(value as Set<unknown>)], path, SET_END));
      return;
    case STRUCT.MAP_START:
      a.nest(enc, () => writeMap(s, enc, a, value as Map<unknown, unknown>, path));
      return;
    default:
      (a.bodies.get(sym) as AnyBody).write(enc, value);
  }
}

function writeObject(
  s: Session,
  enc: Encoder,
  a: AnyCoding,
  value: Record<string, unknown>,
  path: string
): void {
  s.enterScope(path, a.o);
  s.enterRecord();
  try {
    for (const key of Object.keys(value)) {
      try {
        s.marker(path, a.o).write(enc, STRUCT.KEY, undefined, OBJ_END);
        const cps = codePoints(key);
        s.text(path, a.o, 'text').write(enc, cps, cps.length, TEXT);
        writeChild(s, enc, a, path, value[key], `${path}/${key}`);
      } catch (error) {
        throw a.at(error, key);
      }
    }
    s.marker(path, a.o).write(enc, STRUCT.OBJ_END, undefined, OBJ_END);
  } finally {
    s.leaveRecord();
    s.leaveScope();
  }
}

function writeItems(
  s: Session,
  enc: Encoder,
  a: AnyCoding,
  items: readonly unknown[],
  path: string,
  bound: { end: number; allow: boolean }
): void {
  s.enterScope(path, a.o);
  s.enterList();
  try {
    for (let i = 0; i < items.length; i++) {
      s.nextItem();
      try {
        writeChild(s, enc, a, path, items[i], `${path}/*`, bound);
      } catch (error) {
        throw a.at(error, i);
      }
    }
    s.marker(path, a.o).write(enc, bound.end, undefined, bound);
  } finally {
    s.leaveList();
    s.leaveScope();
  }
}

function writeMap(
  s: Session,
  enc: Encoder,
  a: AnyCoding,
  value: Map<unknown, unknown>,
  path: string
): void {
  s.enterScope(path, a.o);
  s.enterList();
  try {
    let i = 0;
    for (const [key, item] of value) {
      s.nextItem();
      s.enterRecord();
      try {
        writeChild(s, enc, a, path, key, `${path}/*`, MAP_END);
        writeChild(s, enc, a, path, item, `${path}/*/`);
      } catch (error) {
        throw a.at(error, i);
      } finally {
        s.leaveRecord();
      }
      i++;
    }
    s.marker(path, a.o).write(enc, STRUCT.MAP_END, undefined, MAP_END);
  } finally {
    s.leaveList();
    s.leaveScope();
  }
}

/** Reads a child `writeChild` wrote; `bound` as written, its end returned as `END_READ`. */
function readChild(
  s: Session,
  dec: Decoder,
  a: AnyCoding,
  path: string,
  childPath: string,
  bound?: { end: number; allow: boolean }
): unknown {
  const sym = s.marker(path, a.o).read(dec, undefined, bound);
  if (bound !== undefined && sym === bound.end) {
    return END_READ;
  }
  return readBody(s, dec, a, childPath, sym);
}

/** What `readChild` returns for a container's end. */
const END_READ: unique symbol = Symbol('end');

function readBody(s: Session, dec: Decoder, a: AnyCoding, path: string, sym: number): unknown {
  const o = a.o;
  switch (sym) {
    case STRUCT.STR:
      return fromCodePoints(s.string(path, o, 'text').read(dec, TEXT));
    case STRUCT.INT:
      return s.number(path, o, {}, a.int).read(dec);
    case STRUCT.DATE:
      return new Date(s.number(path, o, {}, a.int).read(dec));
    case STRUCT.NUM: {
      const text = fromCodePoints(s.text(path, o, 'text').read(dec, TEXT));
      const x = Number(text);
      // The encoder writes a number's own text, so any other text was never written.
      if (numberText(x) !== text || (Number.isSafeInteger(x) && !Object.is(x, -0))) {
        throw new CorruptInputError(`p.any read ${JSON.stringify(text)} where a number belongs`);
      }
      return x;
    }
    case STRUCT.TRUE:
      return true;
    case STRUCT.FALSE:
      return false;
    case STRUCT.NULL:
      return null;
    case STRUCT.UNDEFINED:
      return undefined;
    case STRUCT.HINT: {
      const i = s.step([a.node, 1], o, a.hints).read(dec);
      return a.nest(dec, () => a.readHint(dec, i));
    }
    case STRUCT.OBJ_START:
      return a.nest(dec, () => readObject(s, dec, a, path));
    case STRUCT.ARR_START:
      return a.nest(dec, () => readItems(s, dec, a, path, ARR_END));
    case STRUCT.SET_START:
      return a.nest(dec, () => new Set(readItems(s, dec, a, path, SET_END)));
    case STRUCT.MAP_START:
      return a.nest(dec, () => readMap(s, dec, a, path));
  }
  const body = a.bodies.get(sym);
  if (body === undefined) {
    throw new CorruptInputError(`p.any read structure symbol ${sym} where a value belongs`);
  }
  return body.read(dec);
}

function readObject(s: Session, dec: Decoder, a: AnyCoding, path: string): unknown {
  s.enterScope(path, a.o);
  s.enterRecord();
  try {
    const out: Record<string, unknown> = {};
    for (;;) {
      const sym = s.marker(path, a.o).read(dec, undefined, OBJ_END);
      if (sym === STRUCT.OBJ_END) {
        return out;
      }
      if (sym !== STRUCT.KEY) {
        throw new CorruptInputError(`p.any read structure symbol ${sym} where a key belongs`);
      }
      const key = fromCodePoints(s.text(path, a.o, 'text').read(dec, TEXT));
      let v: unknown;
      try {
        v = readChild(s, dec, a, path, `${path}/${key}`);
      } catch (error) {
        throw a.at(error, key);
      }
      // An own property even for '__proto__', which plain assignment would hand to the setter.
      Object.defineProperty(out, key, {
        value: v,
        writable: true,
        enumerable: true,
        configurable: true,
      });
    }
  } finally {
    s.leaveRecord();
    s.leaveScope();
  }
}

function readItems(
  s: Session,
  dec: Decoder,
  a: AnyCoding,
  path: string,
  bound: { end: number; allow: boolean }
): unknown[] {
  s.enterScope(path, a.o);
  s.enterList();
  try {
    const items: unknown[] = [];
    for (;;) {
      s.nextItem();
      let v: unknown;
      try {
        v = readChild(s, dec, a, path, `${path}/*`, bound);
      } catch (error) {
        throw a.at(error, items.length);
      }
      if (v === END_READ) {
        return items;
      }
      items.push(v);
    }
  } finally {
    s.leaveList();
    s.leaveScope();
  }
}

function readMap(s: Session, dec: Decoder, a: AnyCoding, path: string): unknown {
  s.enterScope(path, a.o);
  s.enterList();
  try {
    const out = new Map<unknown, unknown>();
    for (;;) {
      s.nextItem();
      s.enterRecord();
      try {
        const key = readChild(s, dec, a, path, `${path}/*`, MAP_END);
        if (key === END_READ) {
          return out;
        }
        // A repeated key overwrites, as the plain map does.
        out.set(key, readChild(s, dec, a, path, `${path}/*/`));
      } catch (error) {
        throw a.at(error, out.size);
      } finally {
        s.leaveRecord();
      }
    }
  } finally {
    s.leaveList();
    s.leaveScope();
  }
}
