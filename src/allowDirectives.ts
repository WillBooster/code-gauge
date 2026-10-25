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
// Ruby has no decorators; a line starting with `@` assigns an instance variable.
const languagesWithoutDecorators = new Set(['ruby']);
// A string on one line, whose brackets do not open or close the arguments of a decorator.
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
    functionHeads: findFunctionHeads(
      lines,
      codeLines,
      metrics.functions,
      languagesWithoutDecorators.has(metrics.language) ? undefined : decoratorPattern
    ),
  };
  if (!content.includes(allowKeyword)) {
    return result;
  }
  for (let line = 1; line <= lines.length; line++) {
    const parsed = codeLines.has(line) ? undefined : parseLine(line, lines[line - 1] ?? '', result.functionHeads);
    if (typeof parsed === 'string') {
      result.problems.push({ line, message: parsed });
    } else if (parsed) {
      result.directives.push(parsed);
    }
  }
  return result;
}

/**
 * Walks up from each function over the comment lines and, outside the brackets of a decorator or
 * attribute spanning lines, the lines opening one, stopping at a blank line or other code.
 */
function findFunctionHeads(
  lines: readonly string[],
  codeLines: ReadonlySet<number>,
  functions: readonly FunctionMetrics[],
  decorator: RegExp | undefined
): Map<FunctionMetrics, number> {
  const heads = new Map<FunctionMetrics, number>();
  for (const fn of functions) {
    let head = fn.startLine;
    // The brackets closed below the current line and not yet opened, counted bottom-up.
    let depth = 0;
    for (let line = fn.startLine - 1; line >= 1 && depth >= 0; line--) {
      const text = lines[line - 1] ?? '';
      if (codeLines.has(line)) {
        const code = text.replaceAll(stringLiteralPattern, '');
        depth += (code.match(/[)\]}]/gu)?.length ?? 0) - (code.match(/[([{]/gu)?.length ?? 0);
        if (depth > 0) continue;
        if (depth < 0 || !decorator?.test(text)) break;
      } else if (depth > 0) {
        continue;
      } else if (text.trim() === '') {
        break;
      }
      head = line;
    }
    if (head < fn.startLine) heads.set(fn, head);
  }
  return heads;
}

/** The directive on a comment-only line, what is wrong with it, or undefined when it holds none. */
function parseLine(
  line: number,
  text: string,
  functionHeads: ReadonlyMap<FunctionMetrics, number>
): AllowDirective | string | undefined {
  const match = directivePattern.exec(text);
  if (!match) return undefined;
  const [, keyword = '', rest = ''] = match;
  const parsed = parseDirective(keyword, rest.replace(/\*\/\s*$/u, '').trim());
  if (typeof parsed === 'string') return parsed;
  if (keyword === allowFileKeyword) return { line, ...parsed };
  // The outermost function whose head holds the directive.
  const [target] = [...functionHeads]
    .filter(([fn, head]) => head <= line && line < fn.startLine)
    .map(([fn]) => fn)
    .toSorted((left, right) => left.startColumn - right.startColumn);
  return target
    ? { line, ...parsed, target }
    : `${allowKeyword} must directly precede a function or its decorators; use ${allowFileKeyword} for the whole file`;
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
