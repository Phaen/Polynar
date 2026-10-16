/**
 * The words of a learned sequence's message, a second spelling of its
 * letters. Where a word may start, a run of letters, possibly empty,
 * follows either as one token among the words the message already spelled
 * or as the escape, after which its letters follow one by one through the
 * contexts. Where a word could take either, the encoder mixes the two
 * (`Encoder.composePriced`), so the word costs −log2 of the sum of their
 * probabilities, not of the likelier one's.
 *
 * A word's odds blend what followed the word before it, the context, with
 * how often it occurred in the message at all, each escaping the share its
 * distinct words take, PPM-C style, and with how often it occurred lately,
 * counts that halve every few hundred words, which take a learned lean of
 * the words' odds: a word the message used a page ago is likelier than its
 * count says. The tokens as a whole take a learned
 * share of the odds, which follows the posterior both sides work out after
 * each word, times the odds that a run after the item before it has
 * letters at all: little after a comma, much after a space. Every word
 * learns the same way whichever spelling wrote it, so both sides keep the
 * same counts.
 */
import {
  costUnits,
  type Decoder,
  type Encoder,
  type Journal,
  type Locator,
  type Span,
  type Undoable,
} from '../packer';
import { Fenwick } from './fenwick';
import { ProviderRef, poolKey, type Pool, type ProviderKind } from './providers';

/** The scale of the word spelling's share: `share / SHARE_ONE`. */
const SHARE_ONE = 1024;
/** The share a message starts at, and its bounds. */
const SHARE_START = 256;
const SHARE_MIN = 16;
const SHARE_MAX = SHARE_ONE - 16;
/** How far the share moves toward each posterior: 2^-SHARE_RATE of the way. */
const SHARE_RATE = 4;
/** The sum past which the odds of a run with letters after an item halve. */
const RUN_LIMIT = 256;

/** The most distinct words a message learns; later new words stay spelled by their letters. */
const MAX_WORDS = 1 << 16;
/** The count sum past which the message's word counts halve. */
const WORD_LIMIT = 1 << 16;
/** The count sum past which a context's counts halve. */
const CONTEXT_LIMIT = 1 << 12;

/** The scale of the recent counts' lean, their part of the words' odds: `lean / LEAN_ONE`. */
const LEAN_ONE = 1024;
/** The lean a message starts at, and its bounds. */
const LEAN_START = 256;
const LEAN_MIN = 16;
const LEAN_MAX = (LEAN_ONE * 3) / 4;
/** How far the lean moves toward each posterior: 2^-LEAN_RATE of the way. */
const LEAN_RATE = 4;
/** What an occurrence adds to its word's recent count. */
const RECENT_STEP = 16;
/** The sum past which the recent counts halve, rounding down: every 256 words or so. */
const RECENT_LIMIT = 1 << 13;
/** The least weight of the recent counts that is not 0: 2^FRESH_BITS. */
const FRESH_BITS = 6;
/** The bound on the blended counts' states times their weight. */
const STEADY_LIMIT = 2 ** 31;

/** The scale of the likelier spelling's weight in a mixture. */
const WEIGHT_BITS = 16;
/** The steps of a bit the weights resolve: 1/256. */
const STEP_BITS = 8;
/** `2^-(i/256)` at the weight scale, for i in [0, 256). */
const POWERS = Array.from({ length: 1 << STEP_BITS }, (_, i) =>
  Math.round(2 ** (WEIGHT_BITS - i / (1 << STEP_BITS)))
);

/**
 * The weights of two spellings costing `a` and `b` `COST_UNITS`: the
 * likelier at `2^WEIGHT_BITS`, the other at that times 2 to the minus the
 * difference, in steps of 1/256 bit, at least 1. Integers throughout, so
 * both sides weigh alike.
 */
export function mixWeights(a: number, b: number): [number, number] {
  const top = 1 << WEIGHT_BITS;
  const steps = Math.min(Math.floor(Math.abs(a - b) / 2 ** (20 - STEP_BITS)), 30 << STEP_BITS);
  const low = Math.max(1, POWERS[steps & ((1 << STEP_BITS) - 1)] >> (steps >> STEP_BITS));
  return a <= b ? [top, low] : [low, top];
}

/** The ops a context takes back: a word recurring, and a word entering. */
const RECUR = 0;
const ENTER = 1;

/**
 * The words seen after one word, by id ascending, with their counts and
 * the sums below each.
 */
class WordContext implements Undoable {
  readonly ids: number[] = [];
  readonly counts: number[] = [];
  /** `below[i]` is the sum of the counts before entry i; one more entry holds the total. */
  readonly below: number[] = [0];

  constructor(private readonly journal?: Journal) {}

  get total(): number {
    return this.below[this.ids.length];
  }

  /** The index of the first id at or above `id`. */
  find(id: number): number {
    const { ids } = this;
    let lo = 0;
    let hi = ids.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (ids[mid] < id) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  }

  /** Counts one more `id`, then halves every count, rounding up, past `CONTEXT_LIMIT`. */
  add(id: number): void {
    const i = this.find(id);
    const { journal } = this;
    if (this.ids[i] === id) {
      this.counts[i]++;
      if (journal?.active === true) {
        journal.own(this, RECUR, i);
      }
    } else {
      this.ids.splice(i, 0, id);
      this.counts.splice(i, 0, 1);
      this.below.push(0);
      if (journal?.active === true) {
        journal.own(this, ENTER, i);
      }
    }
    this.sum(i);
    if (this.total > CONTEXT_LIMIT) {
      const { counts } = this;
      if (journal?.active === true) {
        const saved = counts.slice();
        journal.call(() => {
          for (let j = 0; j < saved.length; j++) {
            counts[j] = saved[j];
          }
          this.sum(0);
        });
      }
      for (let j = 0; j < counts.length; j++) {
        counts[j] = (counts[j] + 1) >> 1;
      }
      this.sum(0);
    }
  }

  /** Recomputes the sums from entry `from` on. */
  private sum(from: number): void {
    const { counts, below } = this;
    for (let j = from; j < counts.length; j++) {
      below[j + 1] = below[j] + counts[j];
    }
  }

  undo(op: number, i: number): void {
    if (op === RECUR) {
      this.counts[i]--;
    } else {
      this.ids.splice(i, 1);
      this.counts.splice(i, 1);
      this.below.pop();
    }
    this.sum(i);
  }
}

/** One message's words on a side. */
interface Words {
  /** Each word's id, by its letters. */
  readonly ids: Map<string, number>;
  /** Each word by id. */
  readonly words: string[];
  /** How often each word occurred. */
  readonly counts: Fenwick;
  /** How often each word occurred lately: `RECENT_STEP` an occurrence, halved past `RECENT_LIMIT`. */
  readonly recent: Fenwick;
  /** The words after each context's key. */
  readonly contexts: Map<number, WordContext>;
  /** The id of the last word with letters, the next word's context; -1 before the first. */
  key: number;
  /** Per item before a run, how often the run was empty and how often not, as odds `2c + 1`. */
  readonly runs: Map<number, [number, number]>;
  /** The word spelling's share, over `SHARE_ONE`. */
  share: number;
  /** The recent counts' lean, over `LEAN_ONE`. */
  lean: number;
  readonly journal?: Journal;
}

/**
 * The odds a token is coded in: each word's states, which blend the
 * context's count and the message's, plus its recent count, then the
 * escape's, the rest of `total`.
 */
interface Odds {
  context: WordContext | undefined;
  /** What a context count weighs: the message's counts and escape. */
  scale: number;
  /** What a message count weighs: the context's escape. */
  reach: number;
  /** What a word's states weigh: the share times the odds of a run with letters. */
  weight: number;
  /** What a blended count weighs within them, and what a recent count does. */
  steady: number;
  fresh: number;
  /** The states the words take. */
  words: number;
  total: number;
  /** The words' states before the weight with the escape's, and without. */
  size: number;
  sum: number;
}

/** Locates a token's residual among the odds `WordModel.read` reads it in. */
class TokenLocator implements Locator<number> {
  state?: Words;

  constructor(private readonly model: WordModel) {}

  locate(residual: number, span: Span): number {
    const state = this.state as Words;
    const { model } = this;
    const { words, total, context, scale, reach, weight, steady, fresh } = model.odds;
    if (residual >= words) {
      span.cum = words;
      span.freq = total - words;
      return -1;
    }
    // Every word learned counts at least 1, so the states below a word
    // rise with its id: the last word whose states start at or below the
    // residual, by a descent over the message's counts and the recent ones
    // that adds the context's below each step.
    const tree = state.counts.nodes;
    const lately = state.recent.nodes;
    const last = state.words.length - 1;
    let step = 1;
    while (step * 2 <= last) {
      step *= 2;
    }
    let pos = 0;
    let prefix = 0;
    let late = 0;
    for (; step >= 1; step >>= 1) {
      const next = pos + step;
      if (next <= last) {
        const counted = prefix + tree[next];
        const recent = late + lately[next];
        let below = reach * counted;
        if (context !== undefined) {
          below += scale * context.below[context.find(next)];
        }
        if (weight * (steady * below + fresh * recent) <= residual) {
          pos = next;
          prefix = counted;
          late = recent;
        }
      }
    }
    span.cum = model.bucket(state, pos);
    span.freq = model.own;
    return pos;
  }
}

/** The vocabulary a message learned: its words, their counts and recency, and the token's odds. */
const VOCABULARY: ProviderKind<Pool | undefined, Words> = {
  name: 'vocabulary',
  key: (pool) => poolKey(pool),
  init: (_, side) => ({
    ids: new Map(),
    words: [],
    counts: new Fenwick([], side.journal),
    recent: new Fenwick([], side.journal),
    contexts: new Map(),
    key: -1,
    runs: new Map(),
    share: SHARE_START,
    lean: LEAN_START,
    journal: side.journal,
  }),
};

/**
 * The word token's odds, and what each word teaches: the vocabulary,
 * learned per message, shared within `pool`, else the model's own.
 */
export class WordModel {
  private readonly vocabulary: ProviderRef<Pool | undefined, Words>;

  constructor(pool?: Pool) {
    this.vocabulary = new ProviderRef(VOCABULARY, pool);
  }

  private message(side: Encoder | Decoder): Words {
    return this.vocabulary.get(side);
  }

  /** The id of `word` on `side`, -1 for a word the message has not learned, the empty one among them. */
  id(side: Encoder | Decoder, word: string): number {
    return this.message(side).ids.get(word) ?? -1;
  }

  /** The letters of word `id`. */
  word(side: Encoder | Decoder, id: number): string {
    return this.message(side).words[id];
  }

  /** What `weigh` last worked out, written over by the next call. */
  readonly odds: Odds = {
    context: undefined,
    scale: 0,
    reach: 0,
    weight: 0,
    steady: 1,
    fresh: 0,
    words: 0,
    total: 0,
    size: 0,
    sum: 0,
  };
  /** The states of the word `place` last placed, and the recent part of them before the weight. */
  own = 0;
  late = 0;

  /**
   * The odds on `state` of the token after `prev`, into `odds`. The words
   * take the share times the odds that a run after `prev` has letters, and
   * word w `c1(w)·N0 + d1·c0(w)` of `(n1 + d1)·N0` states of that, `c1` its
   * count in the context, of sum `n1` over `d1` words, `c0` its count in
   * the message, `N0` their sum plus the distinct words; without a
   * context, `n1 + d1` and `d1` are 1. Those blended counts weigh `steady`
   * and the recent counts `fresh`, which give the recent counts the lean's
   * part of the words' states: `fresh` resolves at least 2^FRESH_BITS
   * steps, by doubling `steady`, unless that takes the blended states past
   * `STEADY_LIMIT`. The escape takes the rest. The total stays under 2^52:
   * `(n1 + d1)` under 2^13, `N0` under 2^17, their product times `steady`
   * under 2^31, and the recent states at most three times the blended.
   */
  private weigh(state: Words, prev: number): Odds {
    const { counts, words, share } = state;
    const [empty, full] = state.runs.get(prev) ?? EVEN;
    const context = state.contexts.get(state.key);
    const n0 = counts.total;
    const scale = n0 + words.length;
    const seen = context === undefined ? 0 : context.ids.length;
    const reach = seen === 0 ? 1 : seen;
    const spread = seen === 0 ? 1 : (context as WordContext).total + seen;
    const sum = seen === 0 ? n0 : (context as WordContext).total * scale + seen * n0;
    const size = scale === 0 ? 1 : spread * scale;
    const recent = state.recent.total;
    let steady = 1;
    let fresh = 0;
    if (recent > 0) {
      const lean = sum * state.lean;
      const rest = recent * (LEAN_ONE - state.lean);
      while (steady * lean < rest << FRESH_BITS && steady * 2 * size < STEADY_LIMIT) {
        steady *= 2;
      }
      fresh = Math.floor((steady * lean) / rest);
    }
    const { odds } = this;
    odds.context = seen === 0 ? undefined : context;
    odds.scale = scale;
    odds.reach = reach;
    odds.weight = share * full;
    odds.steady = steady;
    odds.fresh = fresh;
    odds.size = steady * size + fresh * recent;
    odds.sum = steady * sum + fresh * recent;
    odds.words = share * full * odds.sum;
    odds.total = SHARE_ONE * (empty + full) * odds.size;
    return odds;
  }

  /** The states below word `id` under `odds` as they stand, placing it. */
  bucket(state: Words, id: number): number {
    const { context, scale, reach, weight, steady, fresh } = this.odds;
    this.place(state, id);
    let below = reach * state.counts.prefix(id);
    if (context !== undefined) {
      below += scale * context.below[context.find(id)];
    }
    return weight * (steady * below + fresh * state.recent.prefix(id));
  }

  /** Places word `id` under `odds` as they stand, into `own` and `late`. */
  private place(state: Words, id: number): void {
    const { context, scale, reach, weight, steady, fresh } = this.odds;
    let own = reach * state.counts.count(id);
    if (context !== undefined) {
      const i = context.find(id);
      if (context.ids[i] === id) {
        own += scale * context.counts[i];
      }
    }
    const late = fresh * state.recent.count(id);
    this.late = late;
    this.own = weight * (steady * own + late);
  }

  /** Writes, after `prev`, the token of word `id`, -1 for the escape. */
  write(enc: Encoder, prev: number, id: number): void {
    const state = this.message(enc);
    const { words, total } = this.weigh(state, prev);
    if (words === 0) {
      return;
    }
    if (id < 0) {
      enc.composeWeighted(words, total - words, total);
    } else {
      const below = this.bucket(state, id);
      enc.composeWeighted(below, this.own, total);
    }
  }

  /** Reads, after `prev`, a token `write` wrote. */
  read(dec: Decoder, prev: number): number {
    const state = this.message(dec);
    const { words, total } = this.weigh(state, prev);
    if (words === 0) {
      return -1;
    }
    const locator = this.locator;
    locator.state = state;
    return dec.parseLocated(total, locator);
  }

  /** What `read` locates a token's residual with. */
  private readonly locator = new TokenLocator(this);

  /** The cost, in `COST_UNITS`, of the token `write` writes for `id` after `prev`. */
  units(side: Encoder | Decoder, prev: number, id: number): number {
    const state = this.message(side);
    const { words, total } = this.weigh(state, prev);
    if (words === 0) {
      return 0;
    }
    if (id < 0) {
      return costUnits(total - words, total);
    }
    this.place(state, id);
    return costUnits(this.own, total);
  }

  /**
   * The weights `mixWeights` gives word `id`'s two spellings after `prev`:
   * the escape's `units` plus `letters`, the cost of the letters after it,
   * and the token's.
   */
  mixture(side: Encoder | Decoder, prev: number, letters: number, id: number): [number, number] {
    const state = this.message(side);
    const { words, total } = this.weigh(state, prev);
    if (words === 0) {
      return mixWeights(letters, 0);
    }
    this.place(state, id);
    return mixWeights(costUnits(total - words, total) + letters, costUnits(this.own, total));
  }

  /**
   * Learns `word`, the run the message spelled after `prev`: whether it has
   * letters, and if so one more of it, in the message and in its context.
   * The share moves toward the posterior of the tokens: where both
   * spellings could write the word, `weights`, the second the token's; for
   * a word new to the message, the part of the escape the tokens' own
   * escape takes. The lean moves toward the part of a learned word's
   * states its recent count held, whichever spelling wrote it, and that
   * count grows. `known` is the word's `id`, which a caller holding it
   * passes on.
   */
  learn(
    side: Encoder | Decoder,
    prev: number,
    word: string,
    weights?: readonly [number, number],
    known = this.id(side, word)
  ): void {
    const state = this.message(side);
    const { ids, words, counts, recent, contexts, runs, journal } = state;
    const active = journal?.active === true;
    let lean = -1;
    if (known !== -1) {
      this.weigh(state, prev);
      this.place(state, known);
      lean = Math.floor((this.late * LEAN_ONE) / (this.own / this.odds.weight));
    }
    let posterior = -1;
    if (weights !== undefined) {
      posterior = Math.floor((weights[1] * SHARE_ONE) / (weights[0] + weights[1]));
    } else if (word.length > 0 && known === -1) {
      const { weight, size, sum, total, words: known } = this.weigh(state, prev);
      posterior = Math.floor((weight * (size - sum) * SHARE_ONE) / (total - known));
    }
    let cell = runs.get(prev);
    if (cell === undefined) {
      cell = [EVEN[0], EVEN[1]];
      runs.set(prev, cell);
      if (active) {
        journal.drop(runs, prev);
      }
    } else if (active) {
      journal.pair(cell, cell[0], cell[1]);
    }
    cell[word.length === 0 ? 0 : 1] += 2;
    if (cell[0] + cell[1] > RUN_LIMIT) {
      cell[0] = ((cell[0] + 1) >> 1) | 1;
      cell[1] = ((cell[1] + 1) >> 1) | 1;
    }
    if (word.length === 0) {
      return;
    }
    let id = known === -1 ? undefined : known;
    if (id === undefined && words.length < MAX_WORDS) {
      id = words.length;
      ids.set(word, id);
      if (active) {
        journal.drop(ids, word);
        journal.truncate(words, words.length);
      }
      words.push(word);
      counts.push(0);
      recent.push(0);
    }
    if (id !== undefined) {
      counts.add(id, 1);
      if (counts.total > WORD_LIMIT) {
        counts.halve(true);
      }
      recent.add(id, RECENT_STEP);
      if (recent.total > RECENT_LIMIT) {
        recent.halve();
      }
      let context = contexts.get(state.key);
      if (context === undefined) {
        context = new WordContext(journal);
        contexts.set(state.key, context);
        if (active) {
          journal.drop(contexts, state.key);
        }
      }
      context.add(id);
    }
    const key = id ?? -1;
    if (key !== state.key) {
      if (active) {
        journal.set(state, 'key', state.key);
      }
      state.key = key;
    }
    if (posterior >= 0) {
      this.move(state, 'share', posterior, SHARE_RATE, SHARE_MIN, SHARE_MAX);
    }
    if (lean >= 0) {
      this.move(state, 'lean', lean, LEAN_RATE, LEAN_MIN, LEAN_MAX);
    }
  }

  /** Moves `state[key]` 2^-`rate` of the way toward `posterior`, within `[min, max]`. */
  private move(
    state: Words,
    key: 'share' | 'lean',
    posterior: number,
    rate: number,
    min: number,
    max: number
  ): void {
    const { journal } = state;
    const next = Math.min(max, Math.max(min, state[key] + ((posterior - state[key]) >> rate)));
    if (next !== state[key]) {
      if (journal?.active === true) {
        journal.set(state, key, state[key]);
      }
      state[key] = next;
    }
  }
}

/** The odds of a run with letters after an item before any run: as likely as an empty one. */
const EVEN: readonly [number, number] = [1, 1];
