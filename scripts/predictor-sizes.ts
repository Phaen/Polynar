/**
 * The phase-1 measurement gate of the similarity predictor: the real bytes of the four sets
 * (scripts/predictor-sets.ts) coded through a real Encoder with the session's string coder and
 * the shipped text prior, each message decoded back with a real Decoder and compared. One line
 * per set: symbols (END included), bytes, the gate, PASS or FAIL, and encode and decode time per
 * symbol. The exit code is 1 when a set misses its gate.
 *
 *   npx tsx scripts/predictor-sizes.ts <alice.txt> <corpus dir>
 *     [--features tree=false,offsetAgreement=false,...] [--value-from-second]
 *     [--sets alice,prose,chat,names]
 */

import { Decoder, Encoder } from '../src/packer';
import type { Features, SessionOptions } from '../src/predictor/session';
import { SET_NAMES, messages, readMessage, writeMessage } from './predictor-sets';
import type { SetName } from './predictor-sets';

/** Prototype real-coder bytes + 0.5%. */
const GATES: Record<SetName, number> = { alice: 44100, prose: 46255, chat: 306, names: 2205 };

const USAGE =
  'usage: tsx scripts/predictor-sizes.ts <alice.txt> <corpus dir> [--features name=false,...] ' +
  '[--value-from-second] [--sets alice,prose,chat,names]';

interface Args {
  alice: string;
  corpus: string;
  options: SessionOptions;
  sets: SetName[];
}

function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const features: Partial<Record<keyof Features, boolean>> = {};
  let valueFromSecond = false;
  let sets: SetName[] = [...SET_NAMES];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--features') {
      for (const item of (argv[++i] ?? '').split(',').filter(Boolean)) {
        const [k, v] = item.split('=');
        if (v !== 'true' && v !== 'false') throw new Error(`bad feature switch ${item}`);
        features[k as keyof Features] = v === 'true';
      }
    } else if (a === '--value-from-second') {
      valueFromSecond = true;
    } else if (a === '--sets') {
      sets = (argv[++i] ?? '').split(',').filter(Boolean) as SetName[];
      for (const s of sets) if (!SET_NAMES.includes(s)) throw new Error(`unknown set ${s}`);
    } else {
      positional.push(a);
    }
  }
  if (positional.length !== 2) throw new Error(USAGE);
  return {
    alice: positional[0],
    corpus: positional[1],
    options: { features, valueFromSecond },
    sets,
  };
}

function main(): number {
  const args = parseArgs(process.argv.slice(2));
  const flags = [
    ...Object.entries(args.options.features ?? {}).map(([k, v]) => `${k}=${v}`),
    ...(args.options.valueFromSecond ? ['valueFromSecond'] : []),
  ];
  console.log(`features: ${flags.length > 0 ? flags.join(',') : 'defaults'}`);
  let failed = false;
  for (const set of args.sets) {
    const msgs = messages(set, args.alice, args.corpus);
    let symbols = 0;
    let bytes = 0;
    let encMs = 0;
    let decMs = 0;
    for (const m of msgs) {
      for (const s of m.strings) symbols += s.length + 1;
      const t0 = performance.now();
      const enc = new Encoder();
      writeMessage(enc, enc, m, args.options);
      const out = enc.output();
      const t1 = performance.now();
      const dec = new Decoder(out);
      readMessage(dec, dec, m, args.options);
      const t2 = performance.now();
      bytes += out.length;
      encMs += t1 - t0;
      decMs += t2 - t1;
    }
    const gate = GATES[set];
    const pass = bytes <= gate;
    failed ||= !pass;
    const us = (ms: number): string => ((ms * 1000) / symbols).toFixed(1);
    console.log(
      `${set} symbols=${symbols} bytes=${bytes} gate=${gate} ${pass ? 'PASS' : 'FAIL'} ` +
        `encode=${us(encMs)}us/symbol decode=${us(decMs)}us/symbol`
    );
  }
  return failed ? 1 : 0;
}

process.exitCode = main();

export {};
