import fs from 'node:fs';
import { join } from 'node:path';
import * as helpers from './helpers.js';

export const RATE = 0.25;
let counter = 0;
var mode = 'auto';

export class Ledger {
  #entries = [];

  add(entry) {
    this.#entries.push(entry);
    counter++;
  }

  get size() {
    return this.#entries.length;
  }
}

export async function loadLedger(file) {
  const raw = await fs.promises.readFile(join('.', file), 'utf8');
  const ledger = new Ledger();
  try {
    for (const line of raw.split('\n')) {
      if (line.startsWith('#') || line.trim() === '') {
        continue;
      }
      const [kind, amount] = line.split(',');
      switch (kind) {
        case 'credit':
          ledger.add(Number(amount));
          break;
        case 'debit':
          ledger.add(-Number(amount));
          break;
        default:
          ledger.add(0);
      }
    }
  } catch (error) {
    throw new Error(`parse failed: ${error.message}`);
  }
  return ledger;
}

export function countdown(n) {
  if (n <= 0) {
    return 0;
  }
  do {
    n -= 1;
  } while (n > 10 && n % 2 === 0);
  return countdown(n - 1);
}

const scale = (value) => value * RATE;

export function report(ledger) {
  helpers.log(scale(ledger.size));
  const label = mode === 'auto' ? `auto-${ledger.size}` : 'manual';
  const regex = /^entry-\d+$/u;
  return { label, matches: regex.test(label), scaled: scale(2 ** 8) };
}
