import C from 'tree-sitter-c';
import Cpp from 'tree-sitter-cpp';
import Go from 'tree-sitter-go';
import Java from 'tree-sitter-java';
import JavaScript from 'tree-sitter-javascript';
import Python from 'tree-sitter-python';
import Ruby from 'tree-sitter-ruby';
import Rust from 'tree-sitter-rust';
import TypeScript from 'tree-sitter-typescript';
import type { LanguageDefinition, LanguageName, ParserLanguage } from './types.js';

type GrammarModule = unknown;

const commonFunctionNodes = [
  'function',
  'function_declaration',
  'function_definition',
  'function_expression',
  'function_item',
  'function_signature_item',
  'function_declarator',
  'func_literal',
  'method_declaration',
  'method_definition',
  'method_spec',
  'arrow_function',
  'generator_function',
  'generator_function_declaration',
  'lambda',
  'lambda_expression',
  'closure_expression',
] as const;

const commonClassNodes = [
  'class',
  'class_declaration',
  'class_definition',
  'interface_declaration',
  'trait_item',
  'struct_item',
  'enum_item',
  'union_item',
] as const;

const commonDecisionNodes = [
  'if_statement',
  'elif_clause',
  'else_if_clause',
  'for_statement',
  'for_in_statement',
  'while_statement',
  'do_statement',
  'catch_clause',
  'except_clause',
  'case_clause',
  'switch_case',
  'match_arm',
  'conditional_expression',
  'ternary_expression',
  'if_expression',
  'while_expression',
  'for_expression',
  'loop_expression',
] as const;

// Go `switch`/`select` branches are `*_case` nodes, not the `case_clause`/`switch_case` of other grammars.
const goDecisionNodes = [...commonDecisionNodes, 'expression_case', 'type_case', 'communication_case'] as const;

const javaFunctionNodes = [
  ...commonFunctionNodes,
  'constructor_declaration',
  'compact_constructor_declaration',
] as const;
const javaClassNodes = [
  ...commonClassNodes,
  'enum_declaration',
  'record_declaration',
  'annotation_type_declaration',
  // Counted only when they carry a `class_body` (anonymous classes, JLS 15.9.5).
  'object_creation_expression',
  'enum_constant',
] as const;
const javaDecisionNodes = [
  ...commonDecisionNodes,
  'enhanced_for_statement',
  'switch_block_statement_group',
  'switch_rule',
] as const;

// Ruby node types are keyword-like (`if`, `while`, ...), so they must stay Ruby-specific: the same
// strings appear as anonymous keyword tokens in other grammars and would be double-counted there.
// `block`/`do_block` are Ruby's closures (`items.map { ... }`), the analog of JS callbacks.
const rubyFunctionNodes = ['method', 'singleton_method', 'lambda', 'block', 'do_block'] as const;
// `singleton_class` (`class << self`) opens an eigenclass scope, not a new type declaration.
const rubyClassNodes = ['class', 'module'] as const;
const rubyDecisionNodes = [
  'if',
  'elsif',
  'unless',
  'while',
  'until',
  'for',
  'when',
  'in_clause',
  'rescue',
  'conditional',
  'if_modifier',
  'unless_modifier',
  'while_modifier',
  'until_modifier',
  'rescue_modifier',
] as const;

// `function_declarator` must stay out: it is nested inside every `function_definition` (which
// would double-count) and also appears in body-less prototypes.
const cFunctionNodes = ['function_definition', 'lambda_expression'] as const;
const cClassNodes = ['struct_specifier', 'enum_specifier', 'union_specifier'] as const;
const cDecisionNodes = [...commonDecisionNodes, 'case_statement'] as const;
const cppClassNodes = [...cClassNodes, 'class_specifier'] as const;
const cppDecisionNodes = [...cDecisionNodes, 'for_range_loop'] as const;

function normalizeGrammar(module: GrammarModule): ParserLanguage {
  if (isGrammarWrapper(module, 'default')) {
    return module.default;
  }

  return module;
}

function getTypeScriptGrammar(name: 'typescript' | 'tsx'): ParserLanguage {
  const grammars = TypeScript as unknown as Record<string, GrammarModule>;
  return grammars[name];
}

function isGrammarWrapper(value: GrammarModule, key: 'default'): value is Record<typeof key, ParserLanguage> {
  if (typeof value !== 'object' || value === null || !(key in value)) {
    return false;
  }

  return Boolean((value as Record<string, ParserLanguage>)[key]);
}

export const defaultLanguages: readonly LanguageDefinition[] = [
  {
    name: 'javascript',
    aliases: ['js', 'mjs', 'cjs'],
    parserLanguage: normalizeGrammar(JavaScript as unknown as GrammarModule),
  },
  {
    name: 'jsx',
    parserLanguage: normalizeGrammar(JavaScript as unknown as GrammarModule),
  },
  {
    name: 'typescript',
    aliases: ['ts'],
    parserLanguage: getTypeScriptGrammar('typescript'),
  },
  {
    name: 'tsx',
    parserLanguage: getTypeScriptGrammar('tsx'),
  },
  {
    name: 'python',
    aliases: ['py'],
    parserLanguage: normalizeGrammar(Python as unknown as GrammarModule),
  },
  {
    name: 'go',
    parserLanguage: normalizeGrammar(Go as unknown as GrammarModule),
    decisionNodeTypes: goDecisionNodes,
    nestingNodeTypes: goDecisionNodes,
  },
  {
    name: 'rust',
    aliases: ['rs'],
    parserLanguage: normalizeGrammar(Rust as unknown as GrammarModule),
  },
  {
    name: 'java',
    parserLanguage: normalizeGrammar(Java as unknown as GrammarModule),
    functionNodeTypes: javaFunctionNodes,
    classNodeTypes: javaClassNodes,
    decisionNodeTypes: javaDecisionNodes,
    nestingNodeTypes: javaDecisionNodes,
  },
  {
    name: 'ruby',
    aliases: ['rb'],
    parserLanguage: normalizeGrammar(Ruby as unknown as GrammarModule),
    functionNodeTypes: rubyFunctionNodes,
    classNodeTypes: rubyClassNodes,
    decisionNodeTypes: rubyDecisionNodes,
    nestingNodeTypes: rubyDecisionNodes,
  },
  {
    name: 'c',
    parserLanguage: normalizeGrammar(C as unknown as GrammarModule),
    functionNodeTypes: cFunctionNodes,
    classNodeTypes: cClassNodes,
    decisionNodeTypes: cDecisionNodes,
    nestingNodeTypes: cDecisionNodes,
  },
  {
    name: 'cpp',
    aliases: ['c++', 'cxx'],
    parserLanguage: normalizeGrammar(Cpp as unknown as GrammarModule),
    functionNodeTypes: cFunctionNodes,
    classNodeTypes: cppClassNodes,
    decisionNodeTypes: cppDecisionNodes,
    nestingNodeTypes: cppDecisionNodes,
  },
].map((language) => ({
  functionNodeTypes: commonFunctionNodes,
  classNodeTypes: commonClassNodes,
  decisionNodeTypes: commonDecisionNodes,
  nestingNodeTypes: commonDecisionNodes,
  ...language,
}));

export function createLanguageRegistry(
  languages: readonly LanguageDefinition[] = defaultLanguages
): Map<LanguageName, LanguageDefinition> {
  const registry = new Map<LanguageName, LanguageDefinition>();

  for (const language of languages) {
    registry.set(language.name, language);
    for (const alias of language.aliases ?? []) {
      registry.set(alias, language);
    }
  }

  return registry;
}

export const supportedLanguages = defaultLanguages.map((language) => language.name);
