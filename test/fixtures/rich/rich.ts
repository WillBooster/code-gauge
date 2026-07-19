import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { helperA, helperB } from './helpers.js';
import type { Widget } from '../shared/types.js';

export type Mode = 'fast' | 'slow' | 'auto';
export interface Task<T extends Widget = Widget> {
  id: number;
  payload: T | undefined;
  tags: string[] & { readonly length: number };
}
type Result<T> = T extends string ? number : boolean;

export const LIMIT = 10;
let counter = 0;
var legacy = 'x';

export class Scheduler {
  private tasks: Task[] = [];

  add(task: Task): void {
    this.tasks.push(task);
    counter += 1;
  }

  async run(mode: Mode): Promise<number> {
    let total = 0;
    try {
      for (const task of this.tasks) {
        // Nested decisions exercise cognitive complexity nesting.
        if (mode === 'fast' && task.id > 0) {
          total += task.id;
        } else if (mode === 'slow' || task.id < 0) {
          while (total < LIMIT) {
            total += 1;
          }
        } else {
          switch (task.id % 3) {
            case 0: {
              total += 3;
              break;
            }
            case 1: {
              total -= 1;
              break;
            }
            default: {
              total = task.id > 100 ? 100 : total;
            }
          }
        }
      }
      const text = await readFile(path.join('.', 'x.txt'), 'utf8');
      total += text.length;
    } catch (error) {
      throw new Error(`failed: ${String(error)}`);
    }
    return total;
  }
}

export function fibonacci(n: number): number {
  return n <= 1 ? n : fibonacci(n - 1) + fibonacci(n - 2);
}

export function orchestrate(scheduler: Scheduler): number {
  const inner = (value: number): number => value * 2;
  scheduler.add({ id: inner(1), payload: undefined, tags: [] as unknown as Task['tags'] });
  helperA();
  helperB(fibonacci(5));
  const widget = { id: 1 } as Widget;
  const size = widget!.id satisfies number;
  return inner(size);
}

/* Two consistently renamed copies below exercise duplication detection. */
export function summarizeOrders(orders: { total: number; kind: string }[]): number {
  let sum = 0;
  for (const order of orders) {
    if (order.kind === 'active') {
      sum += order.total * 2;
    } else {
      sum += order.total;
    }
  }
  return sum;
}

export function summarizeRefunds(refunds: { total: number; kind: string }[]): number {
  let sum = 0;
  for (const refund of refunds) {
    if (refund.kind === 'active') {
      sum += refund.total * 2;
    } else {
      sum += refund.total;
    }
  }
  return sum;
}

export default Scheduler;
