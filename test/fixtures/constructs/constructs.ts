import type { Widget } from './widget.js';
import { helper } from './helper.js';

export type Mode = 'fast' | 'slow';
export interface Task {
  id: number;
  run(): void;
  readonly [key: string]: unknown;
}
export enum Level {
  Low,
  High,
}
export namespace Registry {
  export const items: Task[] = [];
}
declare namespace Ambient {
  const value: number;
}
export abstract class Base<T extends Widget = Widget> {
  protected abstract build(input: T): Task;
  static counter = 0;
  constructor(
    private readonly name: string,
    public level?: Level
  ) {}
  describe(): string;
  describe(prefix?: string): string {
    return `${prefix ?? ''}${this.name}`;
  }
}
export class Impl extends Base {
  protected build(input: Widget): Task {
    if (input.id > 0 && this.level === Level.High) {
      return { id: input.id, run: () => helper(input.id) };
    }
    return { id: 0, run() {} };
  }
}
export function pick<T>(list: readonly T[], index: number): T | undefined {
  const found = list[index] as T | undefined;
  return found ?? list.at(-1)!;
}
export const conditional = <T>(value: T): T extends string ? number : boolean =>
  (typeof value === 'string' ? 1 : true) as never;
export default function main(mode: Mode = 'fast'): number {
  let total = 0;
  for (let i = 0; i < 3; i++) {
    total += mode === 'fast' ? i : -i;
  }
  return total satisfies number;
}
