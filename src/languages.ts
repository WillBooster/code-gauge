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

// Default switch branches add no decision, but their contents are nested inside the switch like
// any other arm, so they appear in the nesting sets only.
const commonNestingNodes = [...commonDecisionNodes, 'switch_default'] as const;
const goNestingNodes = [...goDecisionNodes, 'default_case'] as const;

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

// NCSS node sets: every listed type counts as one non-commenting source statement. The Java set is
// calibrated against PMD's NcssCount rule (`try` counts 0; `else`, `case`/`default` labels,
// `catch`, `finally`, and try-with-resources resources count 1 each); the other languages follow
// the same conventions with their grammar's node types.
const jsNcssNodes = [
  'import_statement',
  'export_statement',
  'lexical_declaration',
  'variable_declaration',
  'function_declaration',
  'generator_function_declaration',
  'class_declaration',
  'abstract_class_declaration',
  'method_definition',
  'abstract_method_signature',
  'class_static_block',
  'field_definition',
  'public_field_definition',
  'type_alias_declaration',
  'interface_declaration',
  'enum_declaration',
  'expression_statement',
  'if_statement',
  'else_clause',
  'switch_statement',
  'switch_case',
  'switch_default',
  'for_statement',
  'for_in_statement',
  'while_statement',
  'do_statement',
  'catch_clause',
  'finally_clause',
  'labeled_statement',
  'return_statement',
  'break_statement',
  'continue_statement',
  'throw_statement',
  'debugger_statement',
  'with_statement',
] as const;

const pythonNcssNodes = [
  'import_statement',
  'import_from_statement',
  'future_import_statement',
  'print_statement',
  'exec_statement',
  'assert_statement',
  'expression_statement',
  'return_statement',
  'delete_statement',
  'raise_statement',
  'pass_statement',
  'break_statement',
  'continue_statement',
  'global_statement',
  'nonlocal_statement',
  'if_statement',
  'elif_clause',
  'else_clause',
  'for_statement',
  'while_statement',
  'except_clause',
  'except_group_clause',
  'finally_clause',
  'with_statement',
  'match_statement',
  'case_clause',
  'function_definition',
  'class_definition',
  'type_alias_statement',
] as const;

const goNcssNodes = [
  'package_clause',
  'import_spec',
  'type_spec',
  'type_alias',
  'const_spec',
  'var_spec',
  'function_declaration',
  'method_declaration',
  'field_declaration',
  // Interface members: `method_elem` in tree-sitter-go 0.21+, `method_spec` in older grammars.
  'method_elem',
  'method_spec',
  'short_var_declaration',
  'expression_statement',
  'send_statement',
  'inc_statement',
  'dec_statement',
  'assignment_statement',
  'if_statement',
  'for_statement',
  'expression_switch_statement',
  'type_switch_statement',
  'select_statement',
  'expression_case',
  'type_case',
  'communication_case',
  'default_case',
  'return_statement',
  'break_statement',
  'continue_statement',
  'goto_statement',
  'fallthrough_statement',
  'defer_statement',
  'go_statement',
  'labeled_statement',
] as const;

const rustNcssNodes = [
  'use_declaration',
  'mod_item',
  'const_item',
  'static_item',
  'struct_item',
  'enum_item',
  'union_item',
  'trait_item',
  'impl_item',
  'function_item',
  'function_signature_item',
  'type_item',
  'associated_type',
  'macro_definition',
  'field_declaration',
  'let_declaration',
  'expression_statement',
  'else_clause',
  'match_arm',
] as const;

const javaNcssNodes = [
  'package_declaration',
  'import_declaration',
  'class_declaration',
  'interface_declaration',
  'enum_declaration',
  'annotation_type_declaration',
  'annotation_type_element_declaration',
  'record_declaration',
  'field_declaration',
  'constant_declaration',
  'method_declaration',
  'constructor_declaration',
  'compact_constructor_declaration',
  'static_initializer',
  'explicit_constructor_invocation',
  'local_variable_declaration',
  'expression_statement',
  'if_statement',
  'while_statement',
  'do_statement',
  'for_statement',
  'enhanced_for_statement',
  'switch_statement',
  'switch_expression',
  'switch_label',
  'break_statement',
  'continue_statement',
  'return_statement',
  'throw_statement',
  'assert_statement',
  'synchronized_statement',
  'labeled_statement',
  'yield_statement',
  'resource',
  'catch_clause',
  'finally_clause',
] as const;

// Ruby statements have no wrapper node types, so bodies are counted positionally (see
// ncssContainerNodeTypes); only clause nodes hanging off non-container parents need listing.
const rubyNcssNodes = ['elsif', 'else', 'when', 'in_clause', 'rescue', 'ensure'] as const;
const rubyNcssContainers = [
  'program',
  'body_statement',
  'then',
  'else',
  'do',
  'block_body',
  'begin',
  'ensure',
] as const;

const cNcssNodes = [
  'preproc_include',
  'preproc_def',
  'preproc_function_def',
  'declaration',
  'type_definition',
  'field_declaration',
  'function_definition',
  // Counted only when they carry a body (see bodylessNcssSpecifierTypes in ncss.ts).
  'struct_specifier',
  'enum_specifier',
  'union_specifier',
  'expression_statement',
  'if_statement',
  'else_clause',
  'switch_statement',
  'case_statement',
  'for_statement',
  'while_statement',
  'do_statement',
  'return_statement',
  'break_statement',
  'continue_statement',
  'goto_statement',
  'labeled_statement',
] as const;
const cppNcssNodes = [
  ...cNcssNodes,
  'class_specifier',
  'namespace_definition',
  'using_declaration',
  'alias_declaration',
  'static_assert_declaration',
  'for_range_loop',
  'catch_clause',
  'throw_statement',
  'co_return_statement',
  'co_yield_statement',
] as const;

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
    ncssNodeTypes: pythonNcssNodes,
  },
  {
    name: 'go',
    parserLanguage: normalizeGrammar(Go as unknown as GrammarModule),
    decisionNodeTypes: goDecisionNodes,
    nestingNodeTypes: goNestingNodes,
    ncssNodeTypes: goNcssNodes,
  },
  {
    name: 'rust',
    aliases: ['rs'],
    parserLanguage: normalizeGrammar(Rust as unknown as GrammarModule),
    ncssNodeTypes: rustNcssNodes,
    ncssContainerNodeTypes: ['block'],
  },
  {
    name: 'java',
    parserLanguage: normalizeGrammar(Java as unknown as GrammarModule),
    functionNodeTypes: javaFunctionNodes,
    classNodeTypes: javaClassNodes,
    decisionNodeTypes: javaDecisionNodes,
    nestingNodeTypes: javaDecisionNodes,
    ncssNodeTypes: javaNcssNodes,
  },
  {
    name: 'ruby',
    aliases: ['rb'],
    parserLanguage: normalizeGrammar(Ruby as unknown as GrammarModule),
    functionNodeTypes: rubyFunctionNodes,
    classNodeTypes: rubyClassNodes,
    decisionNodeTypes: rubyDecisionNodes,
    nestingNodeTypes: rubyDecisionNodes,
    ncssNodeTypes: rubyNcssNodes,
    ncssContainerNodeTypes: rubyNcssContainers,
  },
  {
    name: 'c',
    parserLanguage: normalizeGrammar(C as unknown as GrammarModule),
    functionNodeTypes: cFunctionNodes,
    classNodeTypes: cClassNodes,
    decisionNodeTypes: cDecisionNodes,
    nestingNodeTypes: cDecisionNodes,
    ncssNodeTypes: cNcssNodes,
  },
  {
    name: 'cpp',
    aliases: ['c++', 'cxx'],
    parserLanguage: normalizeGrammar(Cpp as unknown as GrammarModule),
    functionNodeTypes: cFunctionNodes,
    classNodeTypes: cppClassNodes,
    decisionNodeTypes: cppDecisionNodes,
    nestingNodeTypes: cppDecisionNodes,
    ncssNodeTypes: cppNcssNodes,
  },
].map((language) => ({
  functionNodeTypes: commonFunctionNodes,
  classNodeTypes: commonClassNodes,
  decisionNodeTypes: commonDecisionNodes,
  nestingNodeTypes: commonNestingNodes,
  ncssNodeTypes: jsNcssNodes,
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
