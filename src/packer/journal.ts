/**
 * The undo log behind an encoder's transactions. While a mark is open,
 * every change a write makes to a message's state records how to take it
 * back; rolling back to a mark takes those changes back newest first, so
 * the state stands exactly as it did when the mark was taken, lossy changes
 * such as a halving included. Marks nest: `release` closes the innermost,
 * and `rollback` closes a mark with every mark opened inside it, so a write
 * that throws out of its own marks is taken back whole by the one around
 * it. With no mark open nothing is recorded.
 *
 * An undo is a record of an op code, the object it applies to, a key and
 * two numbers, kept in arrays that grow and are reused, so recording one
 * allocates nothing: a length to cut an array back to, a field or entry to
 * set back, the two entries of a pair to set back, a Map entry to drop, or
 * an op of the object's own through `Undoable`. A change rare enough not to
 * matter records a function instead.
 */

/** An object that takes back changes of its own: `undo(op, a, b)` reverses the change recorded as `op` with `a` and `b`. */
export interface Undoable {
  undo(op: number, a: number, b: number): void;
}

/** Op codes of the records `Journal` applies itself; an object's own ops go through `Undoable`. */
const TRUNCATE = 0;
const SET = 1;
const FLAG = 2;
const DROP = 3;
const CALL = 4;
const OWN = 5;
const PAIR = 6;

export class Journal {
  private ops = new Int32Array(256);
  private nums = new Float64Array(512);
  private readonly objs: unknown[] = [];
  private readonly keys: unknown[] = [];
  /** The records kept, oldest first. */
  private size = 0;
  /** Where each open mark starts among the records, outermost first. */
  private readonly marks: number[] = [];
  private open = false;

  /** Whether a mark is open, so changes must record their undo. */
  get active(): boolean {
    return this.open;
  }

  /** Adds a record. */
  private push(op: number, obj: unknown, key: unknown, a: number, b: number): void {
    if (!this.open) {
      return;
    }
    const at = this.size;
    if (at === this.ops.length) {
      const ops = new Int32Array(at * 2);
      ops.set(this.ops);
      this.ops = ops;
      const nums = new Float64Array(at * 4);
      nums.set(this.nums);
      this.nums = nums;
    }
    this.ops[at] = op;
    this.nums[2 * at] = a;
    this.nums[2 * at + 1] = b;
    this.objs[at] = obj;
    this.keys[at] = key;
    this.size = at + 1;
  }

  /** Records that `array` grew from `length` items, to cut it back to them. */
  truncate(array: unknown[], length: number): void {
    this.push(TRUNCATE, array, undefined, length, 0);
  }

  /** Records that `obj[key]` held the number `value`. */
  set(obj: object, key: string | number, value: number): void {
    this.push(SET, obj, key, value, 0);
  }

  /** Records that `obj[key]` held the boolean `value`. */
  flag(obj: object, key: string, value: boolean): void {
    this.push(FLAG, obj, key, value ? 1 : 0, 0);
  }

  /** Records that `pair[0]` and `pair[1]` held the numbers `a` and `b`. */
  pair(pair: number[], a: number, b: number): void {
    this.push(PAIR, pair, undefined, a, b);
  }

  /** Records that `key` was added to `map`, a Map, Set or WeakMap, to drop it again. */
  drop(map: { delete(key: never): boolean }, key: unknown): void {
    this.push(DROP, map, key, 0, 0);
  }

  /** Records a change `undo` takes back. */
  call(undo: () => void): void {
    this.push(CALL, undo, undefined, 0, 0);
  }

  /** Records a change of `obj`'s own, which `obj.undo(op, a, b)` takes back. */
  own(obj: Undoable, op: number, a = 0, b = 0): void {
    this.push(OWN, obj, op, a, b);
  }

  /** Opens a mark and returns it: its depth, the marks open around it. */
  mark(): number {
    this.marks.push(this.size);
    this.open = true;
    return this.marks.length - 1;
  }

  /** Takes back every change since mark `mark`, newest first, and closes it and every mark inside it. */
  rollback(mark: number): void {
    const marks = this.marks;
    this.check(mark, marks.length);
    const to = marks[mark];
    marks.length = mark;
    // Undos record nothing, as none of them changes state through a recording path.
    this.open = false;
    const { ops, nums, objs, keys } = this;
    for (let at = this.size - 1; at >= to; at--) {
      const obj = objs[at] as Record<string | number, unknown>;
      const key = keys[at] as string;
      const a = nums[2 * at];
      switch (ops[at]) {
        case TRUNCATE:
          (obj as unknown as unknown[]).length = a;
          break;
        case SET:
          obj[key] = a;
          break;
        case FLAG:
          obj[key] = a === 1;
          break;
        case DROP:
          (obj as unknown as Map<unknown, unknown>).delete(key);
          break;
        case CALL:
          (obj as unknown as () => void)();
          break;
        case PAIR:
          obj[0] = a;
          obj[1] = nums[2 * at + 1];
          break;
        default:
          (obj as unknown as Undoable).undo(key as unknown as number, a, nums[2 * at + 1]);
      }
      objs[at] = undefined;
      keys[at] = undefined;
    }
    this.size = to;
    this.open = marks.length > 0;
  }

  /**
   * Keeps every change since mark `mark`, the innermost open one, and
   * closes it. Its records stay while a mark around it is open, which may
   * still take them back, and go with the last mark.
   */
  release(mark: number): void {
    const marks = this.marks;
    this.check(mark, marks.length);
    if (mark !== marks.length - 1) {
      throw new RangeError(`Mark ${mark} has marks open inside it`);
    }
    marks.pop();
    if (marks.length === 0) {
      this.open = false;
      this.objs.fill(undefined, 0, this.size);
      this.keys.fill(undefined, 0, this.size);
      this.size = 0;
    }
  }

  /** Refuses a mark that is not open among the `open` marks. */
  private check(mark: number, open: number): void {
    if (!Number.isInteger(mark) || mark < 0 || mark >= open) {
      throw new RangeError(`Mark ${mark} is not open`);
    }
  }
}
