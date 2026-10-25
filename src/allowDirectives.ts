import { duplicationThreshold, fileThresholds, functionThresholds, metricNameOf } from './thresholds.js';
import type { CodeMetrics, FunctionMetrics } from './types.js';

/** A `code-gauge-allow` or `code-gauge-allow-file` comment: the warnings of a metric it allows. */
export interface AllowDirective {
  line: number;
  metric: string;
  /** The largest value of the metric allowed at the warning level. */
  max: number;
  /** The function a `code-gauge-allow` precedes; absent for `code-gauge-allow-file`, which covers the file. */
  target?: FunctionMetrics;
}

/** A directive that cannot be applied as written, or that allows nothing. */
export interface DirectiveProblem {
  line: number;
  message: string;
}

export interface AllowDirectives {
  directives: AllowDirective[];
  problems: DirectiveProblem[];
  /**
   * The first of the comment, decorator, and attribute lines directly above a function, for each
   * function with such lines: where its directives are, or were before a change removed them.
   */
  functionHeads: Map<FunctionMetrics, number>;
}

const allowKeyword = 'code-gauge-allow';
const allowFileKeyword = 'code-gauge-allow-file';
const syntax = `\`${allowKeyword} <metric> <max> -- <reason>\``;

// The comment delimiters of every supported language (`//`, `///`, `/*`, `*`, `#`) may precede the
// keyword; any other text before it makes the comment prose mentioning a directive.
const directivePattern = /^[\s!#*/]*(code-gauge-allow(?:-file)?)(?![\w-])(.*)$/u;
const decoratorPattern = /^\s*(?:@|#\[)/u;
// A string on one line, whose brackets do not open or close a decorator's arguments.
const stringLiteralPattern = /(["'`])(?:\\.|(?!\1).)*\1/gu;
const argumentsPattern = /^(\w+)\s+(\d+(?:\.\d+)?)\s+--\s+\S/u;

const fileMetrics = new Set(fileThresholds.map((threshold) => metricNameOf(threshold)));
const functionMetrics = new Set(
  [...functionThresholds, duplicationThreshold].map((threshold) => metricNameOf(threshold))
);

/**
 * The directives of a file, each on a comment-only line: `code-gauge-allow` attaches to the
 * function starting on the next line (after any decorator or attribute lines) and `code-gauge-allow-file`
 * to the whole file. A directive after code on a line is not read, since the line may hold it in
 * a string.
 */
export function parseAllowDirectives(content: string, metrics: CodeMetrics): AllowDirectives {
  const lines = content.split(/\r\n|\n|\r/u);
  const codeLines = new Set(metrics.codeLineNumbers);
  const result: AllowDirectives = {
    directives: [],
    problems: [],
    functionHeads: findFunctionHeads(lines, codeLines, metrics.functions),
  };
  if (!content.includes(allowKeyword)) {
    return result;
  }
  for (let line = 1; line <= lines.length; line++) {
    const parsed = codeLines.has(line) ? undefined : parseLine(line, lines, codeLines, metrics.functions);
    if (typeof parsed === 'string') {
      result.problems.push({ line, message: parsed });
    } else if (parsed) {
      result.directives.push(parsed);
    }
  }
  return result;
}

function findFunctionHeads(
  lines: readonly string[],
  codeLines: ReadonlySet<number>,
  functions: readonly FunctionMetrics[]
): Map<FunctionMetrics, number> {
  const isHeadLine = (line: number): boolean => {
    const text = lines[line - 1] ?? '';
    return text.trim() !== '' && (!codeLines.has(line) || decoratorPattern.test(text));
  };
  const heads = new Map<FunctionMetrics, number>();
  for (const fn of functions) {
    let head = fn.startLine;
    while (head > 1 && isHeadLine(head - 1)) head--;
    if (head < fn.startLine) heads.set(fn, head);
  }
  return heads;
}

/** The directive on a comment-only line, what is wrong with it, or undefined when it holds none. */
function parseLine(
  line: number,
  lines: readonly string[],
  codeLines: ReadonlySet<number>,
  functions: readonly FunctionMetrics[]
): AllowDirective | string | undefined {
  const match = directivePattern.exec(lines[line - 1] ?? '');
  if (!match) return undefined;
  const [, keyword = '', rest = ''] = match;
  const parsed = parseDirective(keyword, rest.replace(/\*\/\s*$/u, '').trim());
  if (typeof parsed === 'string') return parsed;
  if (keyword === allowFileKeyword) return { line, ...parsed };
  const target = findTarget(line, lines, codeLines, functions);
  return typeof target === 'string' ? target : { line, ...parsed, target };
}

/** The metric and max of a directive, or what is wrong with it. */
function parseDirective(keyword: string, rest: string): { metric: string; max: number } | string {
  const match = argumentsPattern.exec(rest);
  if (!match) {
    return `malformed directive; expected ${syntax.replace(allowKeyword, keyword)} with a reason`;
  }
  const [, metric = '', max = ''] = match;
  const allowed = keyword === allowFileKeyword ? new Set([...functionMetrics, ...fileMetrics]) : functionMetrics;
  if (allowed.has(metric)) {
    return { metric, max: Number(max) };
  }
  if (fileMetrics.has(metric)) {
    return `${metric} is measured per file; allow it with ${allowFileKeyword}`;
  }
  return `unknown metric ${metric}; expected one of ${[...allowed].join(', ')}`;
}

/**
 * The outermost function starting on the line after the directive's comment block or, when that
 * line opens decorators or attributes a function's span leaves out, on the line after them.
 */
function findTarget(
  directiveLine: number,
  lines: readonly string[],
  codeLines: ReadonlySet<number>,
  functions: readonly FunctionMetrics[]
): FunctionMetrics | string {
  let next = directiveLine + 1;
  while (next <= lines.length && !codeLines.has(next) && (lines[next - 1] ?? '').trim() !== '') {
    next++;
  }
  if (!codeLines.has(next)) {
    return `${allowKeyword} must directly precede a function; use ${allowFileKeyword} for the whole file`;
  }
  const outermostStartingOn = (line: number): FunctionMetrics | undefined =>
    functions
      .filter((fn) => fn.startLine === line)
      .toSorted((left, right) => left.startColumn - right.startColumn)
      .at(0);
  const declarationLine = skipDecorators(next, lines, codeLines);
  const target = outermostStartingOn(next) ?? outermostStartingOn(declarationLine);
  return target ?? `no function starts on line ${declarationLine}; use ${allowFileKeyword} for the whole file`;
}

/** The first code line from `line` on that is neither a decorator nor an attribute nor inside one. */
function skipDecorators(line: number, lines: readonly string[], codeLines: ReadonlySet<number>): number {
  let depth = 0;
  let current = line;
  for (; current <= lines.length; current++) {
    if (!codeLines.has(current)) continue;
    const text = lines[current - 1] ?? '';
    if (depth === 0 && !decoratorPattern.test(text)) break;
    const code = text.replaceAll(stringLiteralPattern, '');
    depth = Math.max(depth + (code.match(/[([{]/gu)?.length ?? 0) - (code.match(/[)\]}]/gu)?.length ?? 0), 0);
  }
  return current;
}
