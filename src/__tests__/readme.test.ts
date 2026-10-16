/**
 * The README's size tables are what examples/size-comparison.ts prints: a
 * change that moves any of their numbers fails here until the README
 * carries the new ones.
 */

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..', '..');

/** The rows of each table `console.table` printed, as label and cells, the index column dropped. */
function printed(output: string): string[][][] {
  const tables: string[][][] = [];
  for (const line of output.split('\n')) {
    if (line.startsWith('┌')) {
      tables.push([]);
    } else if (/^│ \d/.test(line)) {
      const cells = line
        .split('│')
        .slice(2, -1)
        .map((cell) => cell.trim().replace(/^'(.*)'$/, '$1'));
      tables[tables.length - 1].push(cells);
    }
  }
  return tables;
}

/** The body rows of each Markdown table that starts with a `Payload` column, bold marks dropped. */
function documented(readme: string): string[][][] {
  const tables: string[][][] = [];
  let rows: string[][] | undefined;
  for (const line of readme.split('\n')) {
    if (line.startsWith('| Payload')) {
      rows = [];
      tables.push(rows);
    } else if (rows !== undefined && line.startsWith('| ') && !line.startsWith('| -')) {
      rows.push(
        line
          .split('|')
          .slice(1, -1)
          .map((cell) => cell.trim().replace(/\*\*/g, ''))
      );
    } else if (!line.startsWith('|')) {
      rows = undefined;
    }
  }
  return tables;
}

describe('README size tables', () => {
  it('match what examples/size-comparison.ts prints', () => {
    const output = execFileSync(
      process.execPath,
      [require.resolve('tsx/cli'), join(ROOT, 'examples', 'size-comparison.ts')],
      { cwd: ROOT, encoding: 'utf8' }
    );
    const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
    const tables = printed(output);
    expect(tables).toHaveLength(2);
    expect(tables.every((rows) => rows.length === 7)).toBe(true);
    expect(documented(readme)).toEqual(tables);
  }, 120_000);
});
