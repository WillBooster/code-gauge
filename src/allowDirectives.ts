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
}

const allowKeyword = 'code-gauge-allow';
const allowFileKeyword = 'code-gauge-allow-file';
const syntax = `\`${allowKeyword} <metric> <max> -- <reason>\``;

// The comment delimiters of every supported language (`//`, `///`, `/*`, `*`, `#`) may precede the
// keyword; any other text before it makes the comment prose mentioning a directive.
const directivePattern = /^[\s!#*/]*(code-gauge-allow(?:-file)?)(?![\w-])(.*)$/u;
const trailingDirectivePattern = /(?:\/\/|\/\*|#)\s*code-gauge-allow(?![\w])/u;
const argumentsPattern = /^(\w+)\s+(\d+(?:\.\d+)?)\s+--\s+\S/u;

const fileMetrics = new Set(fileThresholds.map((threshold) => metricNameOf(threshold)));
const functionMetrics = new Set(
  [...functionThresholds, duplicationThreshold].map((threshold) => metricNameOf(threshold))
);

/**
 * The directives of a file, each on a comment-only line: `code-gauge-allow` attaches to the
 * function starting on the next line (after any decorator or attribute lines) and `code-gauge-allow-file`
 * to the whole file.
 */
export function parseAllowDirectives(content: string, metrics: CodeMetrics): AllowDirectives {
  const result: AllowDirectives = { directives: [], problems: [] };
  if (!content.includes(allowKeyword)) {
    return result;
  }
  const lines = content.split(/\r\n|\n|\r/u);
  const codeLines = new Set(metrics.codeLineNumbers);
  for (let line = 1; line <= lines.length; line++) {
    const parsed = parseLine(line, lines, codeLines, metrics.functions);
    if (typeof parsed === 'string') {
      result.problems.push({ line, message: parsed });
    } else if (parsed) {
      result.directives.push(parsed);
    }
  }
  return result;
}

/** The directive on the line, what is wrong with it, or undefined when the line holds none. */
function parseLine(
  line: number,
  lines: readonly string[],
  codeLines: ReadonlySet<number>,
  functions: readonly FunctionMetrics[]
): AllowDirective | string | undefined {
  const text = lines[line - 1] ?? '';
  if (codeLines.has(line)) {
    return trailingDirectivePattern.test(text)
      ? `a directive must be on a comment line of its own: ${syntax}`
      : undefined;
  }
  const match = directivePattern.exec(text);
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
 * line opens a decorator or an attribute, the first function starting after it.
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
  const startingFunctions = /^\s*(?:@|#\[)/u.test(lines[next - 1] ?? '')
    ? functions.filter((fn) => fn.startLine >= next)
    : functions.filter((fn) => fn.startLine === next);
  const [target] = startingFunctions.toSorted(
    (left, right) => left.startLine - right.startLine || left.startColumn - right.startColumn
  );
  return target ?? `no function starts on line ${next}; use ${allowFileKeyword} for the whole file`;
}
