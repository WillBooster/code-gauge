import { readFile } from 'node:fs/promises';
export const LIMIT = 10;
let counter = 0;

export class Queue {
  #items = [];
  static count = 0;
  static {
    Queue.count = 1;
  }
  constructor(items = []) {
    this.#items = [...items];
  }
  get size() {
    return this.#items.length;
  }
  set size(value) {
    counter = value;
  }
  *drain() {
    while (this.#items.length > 0) {
      yield this.#items.pop();
    }
  }
  async #load(path) {
    const text = await readFile(path, 'utf8');
    return text.split('\n');
  }
}

export function classify(items, limit = LIMIT, ...rest) {
  let total = 0;
  outer: for (const item of items) {
    for (const other of rest) {
      if (item === other) continue outer;
    }
    if (item > limit && item % 2 === 0) {
      total += item;
    } else if (item < 0 || item === limit) {
      total -= 1;
    } else {
      total += 1;
    }
  }
  let index = 0;
  do {
    index += 1;
  } while (index < total && index < limit);
  for (const key in { a: 1 }) {
    counter += key.length;
  }
  try {
    switch (total % 3) {
      case 0:
        return 'zero';
      case 1: {
        return total > limit ? 'one-big' : 'one';
      }
      default:
        throw new Error('other');
    }
  } catch (error) {
    return error.message ?? 'unknown';
  } finally {
    counter += 1;
  }
}

export const describe = (value) => {
  const label = value?.name ?? 'anonymous';
  return [1, 2, 3].map((n) => (n > value ? label : `${label}-${n}`)).join(',');
};

export function countdown(n) {
  if (n <= 0) return 0;
  return countdown(n - 1);
}

label: {
  if (counter > 0) break label;
}
