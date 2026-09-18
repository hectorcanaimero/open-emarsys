// Generates the CSV the 1 M-row import scenario uploads. Usage (from tests/e2e):
//   node --experimental-strip-types contacts/fixtures/gen-csv.ts <out.csv> [rows]
// Columns: Email,Nombre,Apellido. Every BAD_EVERY-th row is invalid, alternating between an
// empty email and a missing column; each invalid row carries a unique `bad-<i>` name so the
// error report can be matched to it.
import { once } from 'node:events';
import { createWriteStream } from 'node:fs';

export const BAD_EVERY = 50_000;
export const emailOf = (i: number) => `bulk-${i}@e2e.local`;
export const badName = (i: number) => `bad-${i}`;
export const isBad = (i: number) => i % BAD_EVERY === 7;

/** Rows are 1-based; returns the indexes of the invalid ones. */
export async function genCsv(file: string, rows: number): Promise<number[]> {
  const out = createWriteStream(file);
  const bad: number[] = [];
  out.write('Email,Nombre,Apellido\n');
  let chunk = '';
  for (let i = 1; i <= rows; i++) {
    if (isBad(i)) {
      bad.push(i);
      chunk += bad.length % 2 ? `,${badName(i)},Malo\n` : `${emailOf(i)},${badName(i)}\n`;
    } else {
      chunk += `${emailOf(i)},Nombre${i},Apellido${i}\n`;
    }
    if (i % 10_000 === 0) {
      if (!out.write(chunk)) await once(out, 'drain');
      chunk = '';
    }
  }
  out.write(chunk);
  out.end();
  await once(out, 'finish');
  return bad;
}

if (process.argv[1]?.endsWith('gen-csv.ts')) {
  const [file, rows = '1000000'] = process.argv.slice(2);
  if (!file) throw new Error('usage: gen-csv.ts <out.csv> [rows]');
  genCsv(file, Number(rows)).then((bad) => console.log(`${rows} rows, ${bad.length} invalid`));
}
