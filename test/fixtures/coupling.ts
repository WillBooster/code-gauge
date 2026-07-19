import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { helper } from './helper.js';
import { shared } from '../shared.js';

export const root = path.sep;

export async function load(name: string): Promise<string> {
  const raw = await readFile(name, 'utf8');
  return helper(shared(raw));
}
