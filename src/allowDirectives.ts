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
   * The lines from each directive, applicable or not, to the next code line: a change to them may
   * change what the directive allows.
   */
  attachmentSpans: { startLine: number; endLine: number }[];
}

export const allowKeyword = 'code-gauge-allow';
const allowFileKeyword = 'code-gauge-allow-file';
const syntax = `\`${allowKeyword} <metric> <max> -- <reason>\``;

// The comment delimiters of every supported language (`//`, `///`, `/*`, `*`, `#`) may precede the
// keyword; any other text before it makes the comment prose mentioning a directive.
const directivePattern = /^[\s!#*/]*(code-gauge-allow(?:-file)?)(?![\w-])(.*)$/u;
const argumentsPattern = /^(\w+)\s+(\d+(?:\.\d+)?)\s+--\s+\S/u;

const fileMetrics = new Set(fileThresholds.map((threshold) => metricNameOf(threshold)));
const functionMetrics = new Set(
  [...functionThresholds, duplicationThreshold].map((threshold) => metricNameOf(threshold))
);

/**
 * The directives of a file, each on a comment-only line: `code-gauge-allow` attaches to the
 * function starting on the next code line, with only comment lines between, and
 * `code-gauge-allow-file` to the whole file. Decorators and attributes are not skipped, since
 * telling where one ends takes a parser; a directive for a function whose span starts after them
 * goes below them. A directive after code on a line is not read, since the line may hold it in a
 * string.
 */
export function parseAllowDirectives(content: string, metrics: CodeMetrics): AllowDirectives {
  const result: AllowDirectives = { directives: [], problems: [], attachmentSpans: [] };
  if (!content.includes(allowKeyword)) {
    return result;
  }
  const lines = content.split(/\r\n|\n|\r/u);
  const codeLines = new Set(metrics.codeLineNumbers);
  for (let line = 1; line <= lines.length; line++) {
    const match = codeLines.has(line) ? undefined : directivePattern.exec(lines[line - 1] ?? '');
    if (!match) continue;
    const following = metrics.codeLineNumbers.find((codeLine) => codeLine > line);
    result.attachmentSpans.push({ startLine: line, endLine: following ?? lines.length });
    const isBlankBetween = lines.slice(line, (following ?? lines.length + 1) - 1).some((text) => text.trim() === '');
    const next = isBlankBetween ? undefined : following;
    const [, keyword = '', rest = ''] = match;
    const parsed = parseDirective(keyword, rest.replace(/\*\/\s*$/u, '').trim());
    const directive =
      typeof parsed === 'string' || keyword === allowFileKeyword
        ? parsed
        : attachToFunction(parsed, next, metrics.functions);
    if (typeof directive === 'string') {
      result.problems.push({ line, message: directive });
    } else {
      result.directives.push({ line, ...directive });
    }
  }
  return result;
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

/** The parsed directive with the outermost function starting on `next`, or what is wrong. */
function attachToFunction(
  parsed: { metric: string; max: number },
  next: number | undefined,
  functions: readonly FunctionMetrics[]
): { metric: string; max: number; target: FunctionMetrics } | string {
  const [target] = functions
    .filter((fn) => fn.startLine === next)
    .toSorted((left, right) => left.startColumn - right.startColumn);
  if (target) {
    return { ...parsed, target };
  }
  return next === undefined
    ? `${allowKeyword} must directly precede a function; use ${allowFileKeyword} for the whole file`
    : `no function starts on line ${next}, the code after ${allowKeyword}; put it right above the line a function starts on (below decorators the function's span leaves out), or use ${allowFileKeyword}`;
}
