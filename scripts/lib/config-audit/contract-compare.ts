/**
 * audit:flags 的纯指纹与对比面。No fs, no git — callers pass source text.
 *
 * CONFIG_REGISTRY（core/config/registry.ts）是唯一 flag 定义；这里只从源码
 * 文本提取同形指纹（base 与 head 用同一提取器），与运行时定义交叉核对，再做
 * base/head 契约 diff。报告与退出码归 CLI。
 */
import { parse } from '@babel/parser';
import { z } from 'zod';
import type { ConfigKeyDef } from '../../../src/core/config/registry';

// Babel AST nodes are structurally untyped for this audit.
// biome-ignore lint/suspicious/noExplicitAny: Babel AST node shape
export type AstNode = Record<string, any>;

/** Depth-first visit over every typed AST node. */
export function walkAst(node: unknown, fn: (node: AstNode) => void): void {
  if (node === null || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const child of node) walkAst(child, fn);
    return;
  }
  const record = node as AstNode;
  if (typeof record.type === 'string') fn(record);
  for (const key of Object.keys(record)) {
    if (key === 'loc' || key === 'start' || key === 'end' || key === 'extra') continue;
    walkAst(record[key], fn);
  }
}

// ── types ────────────────────────────────────────────────────────────────────────────────────

export type ControlKind = 'flag' | 'enum' | 'csv' | 'json' | 'scalar' | 'other';

export interface FlagGrammarFingerprint {
  trueLiterals: readonly string[];
  falseLiterals: readonly string[];
  caseInsensitive: boolean;
  polarity: 'opt-in' | 'opt-out';
}

export interface DefinitionFingerprint {
  key: string;
  kind: ControlKind;
  codeDefault: unknown;
  /** codeDefault 不是静态字面量时置位：跳过默认值对比，避免假 drift。 */
  codeDefaultUnresolved?: boolean;
  envName: string | null;
  envMode: string;
  tier: string;
  flag: FlagGrammarFingerprint | null;
  /** flag 属性存在但静态不可解析：已单独报问题，不再伪造 BASE-DRIFT。 */
  flagUnresolved?: boolean;
  enumValues: string[] | null | undefined;
}

export interface FingerprintExtraction {
  fingerprints: Map<string, DefinitionFingerprint>;
  problems: string[];
}

export interface HeadDefinition extends DefinitionFingerprint {
  description: string | null;
  consumers: string[] | null;
  reload: string | null;
  exposure: string | null;
  readers: string[];
}

export interface ConstDefinition {
  name: string;
  value: boolean;
  file: string;
}

export type ViolationCode =
  | 'UNREGISTERED'
  | 'DEFINITION-PROBLEM'
  | 'NO-READER'
  | 'ORPHAN-READER'
  | 'ORPHAN-ENV-READ'
  | 'DIRECT-ENV-READ'
  | 'CONST-PROBLEM'
  | 'UNCLASSIFIED-ENV-READ'
  | 'DYNAMIC-ENV-READ'
  | 'REGISTRY-SCHEMA-GAP'
  | 'BASE-PROBLEM'
  | 'BASE-DRIFT';

export interface FlagViolation {
  code: ViolationCode;
  name: string;
  detail: string;
}

export interface DiffEntry {
  name: string;
  field: string;
  base: unknown;
  head: unknown;
}

export interface EnvExampleReport {
  /** Boot-schema keys absent from `.env.example` (report-only). */
  missingFromExample: string[];
  /** `.env.example` keys the boot schema does not own (report-only). */
  notInSchema: string[];
  /** Sample keys with a real `KEY=` assignment line. */
  assignedCount: number;
  /** Sample keys present only as `# KEY=` comments — documented but never set. */
  commentedOnly: string[];
}

export interface FlagAuditResult {
  ok: boolean;
  base: string | null;
  definitions: HeadDefinition[];
  consts: ConstDefinition[];
  foundTokens: string[];
  violations: FlagViolation[];
  diff: DiffEntry[];
  variance: { signature: string; flags: string[] }[];
  envCensus?: EnvCensusReport;
  nonFamily?: NonFamilyReport;
  envExample?: EnvExampleReport;
}

const METADATA_FIELDS = ['description', 'consumers', 'reload', 'exposure'] as const;

/** Grammar probes: literal-domain sides, whitespace, case, and non-flag garbage. */
const GRAMMAR_PROBES = [
  '',
  ' ',
  'true',
  'TRUE',
  'True',
  ' true ',
  '1',
  ' 1 ',
  'false',
  'FALSE',
  'False',
  ' false ',
  '0',
  ' 0 ',
  'yes',
  'no',
  'on',
  'off',
  'enabled',
  '2',
  '-1',
] as const;

// ── expression evaluation / resolution ───────────────────────────────────────────────────────

export function unwrapExpression(expr: AstNode): AstNode {
  let current = expr;
  while (
    current &&
    (current.type === 'TSAsExpression' ||
      current.type === 'TSSatisfiesExpression' ||
      current.type === 'TSNonNullExpression' ||
      current.type === 'ParenthesizedExpression' ||
      current.type === 'ChainExpression' ||
      current.type === 'TypeCastExpression')
  ) {
    current = current.expression;
  }
  return current;
}

const UNKNOWN = Symbol('unknown');

/** Evaluate a literal-only expression; UNKNOWN means "not statically decidable". */
export function evaluateLiteral(expr: AstNode | undefined): unknown {
  if (!expr) return undefined;
  const node = unwrapExpression(expr);
  switch (node.type) {
    case 'StringLiteral':
      return node.value;
    case 'NumericLiteral':
      return node.value;
    case 'BooleanLiteral':
      return node.value;
    case 'NullLiteral':
      return null;
    case 'Identifier':
      return node.name === 'undefined' ? undefined : UNKNOWN;
    case 'UnaryExpression': {
      const value = evaluateLiteral(node.argument);
      if (typeof value !== 'number') return UNKNOWN;
      if (node.operator === '-') return -value;
      if (node.operator === '+') return value;
      return UNKNOWN;
    }
    case 'BinaryExpression': {
      const left = evaluateLiteral(node.left);
      const right = evaluateLiteral(node.right);
      if (typeof left !== 'number' || typeof right !== 'number') return UNKNOWN;
      switch (node.operator) {
        case '+':
          return left + right;
        case '-':
          return left - right;
        case '*':
          return left * right;
        case '/':
          return right === 0 ? UNKNOWN : left / right;
        default:
          return UNKNOWN;
      }
    }
    case 'TemplateLiteral':
      if ((node.expressions ?? []).length === 0) {
        return (node.quasis ?? []).map((quasi: AstNode) => quasi.value?.cooked ?? '').join('');
      }
      return UNKNOWN;
    case 'ArrayExpression': {
      const values: unknown[] = [];
      for (const element of node.elements ?? []) {
        if (!element) return UNKNOWN;
        const value = evaluateLiteral(element);
        if (value === UNKNOWN) return UNKNOWN;
        values.push(value);
      }
      return values;
    }
    case 'ObjectExpression': {
      const value: Record<string, unknown> = {};
      for (const prop of node.properties ?? []) {
        if (prop.type !== 'ObjectProperty' || prop.computed) return UNKNOWN;
        const key =
          prop.key.type === 'Identifier'
            ? prop.key.name
            : prop.key.type === 'StringLiteral'
              ? prop.key.value
              : undefined;
        if (key === undefined) return UNKNOWN;
        const propValue = evaluateLiteral(prop.value);
        if (propValue === UNKNOWN) return UNKNOWN;
        value[key] = propValue;
      }
      return value;
    }
    default:
      return UNKNOWN;
  }
}

// ── definition fingerprints ─────────────────────────────────────────────────────────────────

export function schemaKindOf(schema: z.ZodTypeAny): ControlKind {
  if (schema instanceof z.ZodBoolean) return 'flag';
  if (schema instanceof z.ZodEnum) return 'enum';
  if (schema instanceof z.ZodArray) return 'csv';
  if (schema instanceof z.ZodRecord || schema instanceof z.ZodObject) return 'json';
  if (schema instanceof z.ZodNumber || schema instanceof z.ZodString) return 'scalar';
  return 'other';
}

export function isFamilyKind(kind: ControlKind, hasEnv: boolean): boolean {
  // locale.learner is a DB-only TaskSpec pin, not an operator control: it has no env layer.
  return kind === 'flag' || (hasEnv && (kind === 'enum' || kind === 'csv' || kind === 'json'));
}

export function normalizeGrammar(grammar: FlagGrammarFingerprint): FlagGrammarFingerprint {
  return {
    trueLiterals: [...grammar.trueLiterals],
    falseLiterals: [...grammar.falseLiterals],
    caseInsensitive: grammar.caseInsensitive,
    polarity: grammar.polarity,
  };
}

// ── base registry extraction (AST; same fields, no runtime import of base code) ─────────────

function objectProperty(node: AstNode | undefined, name: string): AstNode | undefined {
  if (node?.type !== 'ObjectExpression') return undefined;
  for (const prop of node.properties ?? []) {
    if (prop.type !== 'ObjectProperty' || prop.computed) continue;
    const key =
      prop.key.type === 'Identifier'
        ? prop.key.name
        : prop.key.type === 'StringLiteral'
          ? prop.key.value
          : undefined;
    if (key === name) return prop.value;
  }
  return undefined;
}

/** Top-level `const` initializers in one module, for same-file constant resolution. */
function constInitializers(ast: AstNode): Map<string, AstNode> {
  const map = new Map<string, AstNode>();
  walkAst(ast, (node) => {
    if (node.type !== 'VariableDeclaration' || node.kind !== 'const') return;
    for (const decl of node.declarations ?? []) {
      if (decl.type !== 'VariableDeclarator' || decl.id?.type !== 'Identifier' || !decl.init) {
        continue;
      }
      if (!map.has(decl.id.name)) map.set(decl.id.name, decl.init);
    }
  });
  return map;
}

/** Resolve literals through same-file const identifiers; UNKNOWN = not statically decidable. */
function resolveStatic(
  node: AstNode | undefined,
  consts: Map<string, AstNode>,
  depth = 0,
): unknown {
  if (!node || depth > 8) return UNKNOWN;
  const current = unwrapExpression(node);
  if (current.type === 'Identifier') {
    if (current.name === 'undefined') return undefined;
    const init = consts.get(current.name);
    return init ? resolveStatic(init, consts, depth + 1) : UNKNOWN;
  }
  if (current.type === 'ArrayExpression') {
    const values: unknown[] = [];
    for (const element of current.elements ?? []) {
      if (!element) return UNKNOWN;
      const value = resolveStatic(element, consts, depth + 1);
      if (value === UNKNOWN) return UNKNOWN;
      values.push(value);
    }
    return values;
  }
  if (current.type === 'ObjectExpression') {
    const value: Record<string, unknown> = {};
    for (const prop of current.properties ?? []) {
      if (prop.type !== 'ObjectProperty' || prop.computed) return UNKNOWN;
      const key =
        prop.key.type === 'Identifier'
          ? prop.key.name
          : prop.key.type === 'StringLiteral'
            ? prop.key.value
            : undefined;
      if (key === undefined) return UNKNOWN;
      const propValue = resolveStatic(prop.value, consts, depth + 1);
      if (propValue === UNKNOWN) return UNKNOWN;
      value[key] = propValue;
    }
    return value;
  }
  return evaluateLiteral(current);
}

function grammarFromAst(
  node: AstNode | undefined,
  consts: Map<string, AstNode>,
  depth = 0,
): FlagGrammarFingerprint | null | typeof UNKNOWN {
  if (!node || depth > 8) return null;
  const current = unwrapExpression(node);
  if (current.type === 'Identifier') {
    const init = consts.get(current.name);
    return init ? grammarFromAst(init, consts, depth + 1) : UNKNOWN;
  }
  if (current.type !== 'ObjectExpression') return UNKNOWN;
  const trueLiterals = stringArrayFromAst(objectProperty(current, 'trueLiterals'), consts);
  const falseLiterals = stringArrayFromAst(objectProperty(current, 'falseLiterals'), consts);
  const caseInsensitive = resolveStatic(objectProperty(current, 'caseInsensitive'), consts);
  const polarity = resolveStatic(objectProperty(current, 'polarity'), consts);
  if (
    !trueLiterals ||
    !falseLiterals ||
    typeof caseInsensitive !== 'boolean' ||
    (polarity !== 'opt-in' && polarity !== 'opt-out')
  ) {
    return UNKNOWN;
  }
  return { trueLiterals, falseLiterals, caseInsensitive, polarity };
}

function stringArrayFromAst(
  node: AstNode | undefined,
  consts: Map<string, AstNode>,
): string[] | undefined {
  const value = resolveStatic(node, consts);
  if (!Array.isArray(value)) return undefined;
  return value.every((item) => typeof item === 'string') ? (value as string[]) : undefined;
}

function schemaKindFromAst(node: AstNode | undefined): ControlKind {
  const schema = node ? unwrapExpression(node) : undefined;
  if (schema?.type !== 'CallExpression') return 'other';
  const callee = schema.callee;
  if (callee?.type !== 'MemberExpression') return 'other';
  // Chained builders (`.strict()`, `.refine(...)`, `.optional()`) wrap the real schema call.
  if (callee.object?.type !== 'Identifier') return schemaKindFromAst(callee.object);
  if (callee.object.name !== 'z' || callee.property?.type !== 'Identifier') return 'other';
  switch (callee.property.name) {
    case 'boolean':
      return 'flag';
    case 'enum':
      return 'enum';
    case 'array':
      return 'csv';
    case 'record':
    case 'object':
      return 'json';
    case 'number':
    case 'string':
      return 'scalar';
    default:
      return 'other';
  }
}

function enumValuesFromAst(
  node: AstNode | undefined,
  consts: Map<string, AstNode>,
): string[] | undefined {
  const schema = node ? unwrapExpression(node) : undefined;
  if (schema?.type !== 'CallExpression') return undefined;
  const first = schema.arguments?.[0];
  return stringArrayFromAst(first, consts);
}

/**
 * Extract CONFIG_REGISTRY fingerprints from source text. Used for BOTH base and head so the
 * comparison is apples-to-apples; same-file `const` identifiers (e.g. `flag: OPT_IN_FLAG`) are
 * resolved, and anything not statically decidable is reported instead of faked as drift.
 */
export function extractRegistryFingerprints(sourceText: string): FingerprintExtraction {
  const ast = parse(sourceText, {
    sourceType: 'module',
    plugins: ['typescript'],
    errorRecovery: true,
  }) as unknown as AstNode;
  const consts = constInitializers(ast);
  let registry: AstNode | undefined;
  walkAst(ast, (node) => {
    if (registry) return;
    if (node.type !== 'VariableDeclarator' || node.id?.type !== 'Identifier') return;
    if (node.id.name !== 'CONFIG_REGISTRY') return;
    const init = node.init ? unwrapExpression(node.init) : undefined;
    if (init?.type === 'ObjectExpression') registry = init;
  });
  const result = new Map<string, DefinitionFingerprint>();
  const problems: string[] = [];
  if (!registry) return { fingerprints: result, problems };

  for (const prop of registry.properties ?? []) {
    if (prop.type !== 'ObjectProperty' || prop.computed) continue;
    const key =
      prop.key.type === 'Identifier'
        ? prop.key.name
        : prop.key.type === 'StringLiteral'
          ? prop.key.value
          : undefined;
    if (key === undefined) continue;
    const node = prop.value;
    const schemaNode = objectProperty(node, 'schema');
    const kind = schemaKindFromAst(schemaNode);

    const envNameNode = objectProperty(node, 'envName');
    const envNameValue = resolveStatic(envNameNode, consts);
    if (envNameNode && envNameValue === UNKNOWN) {
      problems.push(`${key}: envName is not statically decidable`);
    }
    const envName = typeof envNameValue === 'string' ? envNameValue : null;
    if (!isFamilyKind(kind, envName !== null)) continue;

    const flagNode = objectProperty(node, 'flag');
    const grammar = grammarFromAst(flagNode, consts);
    if (grammar === UNKNOWN) {
      problems.push(
        `${key}: flag grammar is not statically resolvable (use a literal object or a same-file const)`,
      );
    }

    const codeDefaultValue = resolveStatic(objectProperty(node, 'codeDefault'), consts);
    const envModeValue = resolveStatic(objectProperty(node, 'envMode'), consts);
    const tierValue = resolveStatic(objectProperty(node, 'tier'), consts);
    if (objectProperty(node, 'envMode') && envModeValue === UNKNOWN) {
      problems.push(`${key}: envMode is not statically decidable`);
    }
    if (objectProperty(node, 'tier') && tierValue === UNKNOWN) {
      problems.push(`${key}: tier is not statically decidable`);
    }

    const enumValues = kind === 'enum' ? enumValuesFromAst(schemaNode, consts) : null;
    if (kind === 'enum' && !enumValues) {
      problems.push(`${key}: enum values are not statically resolvable`);
    }

    result.set(key, {
      key,
      kind,
      codeDefault: codeDefaultValue === UNKNOWN ? undefined : codeDefaultValue,
      codeDefaultUnresolved: codeDefaultValue === UNKNOWN,
      envName,
      envMode: typeof envModeValue === 'string' ? envModeValue : 'fallback',
      tier: typeof tierValue === 'string' ? tierValue : 'A',
      flag: grammar === UNKNOWN ? null : grammar,
      flagUnresolved: grammar === UNKNOWN,
      enumValues,
    });
  }
  return { fingerprints: result, problems };
}

// ── validation ──────────────────────────────────────────────────────────────────────────────

function expectedFromGrammar(grammar: FlagGrammarFingerprint, raw: string): boolean | undefined {
  const normalized = grammar.caseInsensitive ? raw.trim().toLowerCase() : raw;
  if (grammar.trueLiterals.includes(normalized)) return true;
  if (grammar.falseLiterals.includes(normalized)) return false;
  return undefined;
}

export function grammarProblems(def: ConfigKeyDef, key: string): string[] {
  const problems: string[] = [];
  const grammar = def.flag;
  if (!grammar) return [`${key}: boolean flag has no flag grammar metadata`];
  if (def.envName !== key) {
    problems.push(`${key}: envName must equal the registered key (got ${def.envName ?? 'none'})`);
  }
  if (typeof def.codeDefault !== 'boolean') {
    problems.push(`${key}: boolean flag needs a boolean codeDefault`);
  } else {
    const polarity = def.codeDefault ? 'opt-out' : 'opt-in';
    if (grammar.polarity !== polarity) {
      problems.push(
        `${key}: polarity '${grammar.polarity}' contradicts codeDefault ${String(def.codeDefault)} (expected '${polarity}')`,
      );
    }
  }
  if (grammar.trueLiterals.length === 0) problems.push(`${key}: trueLiterals must not be empty`);
  if (typeof def.envParse !== 'function') {
    problems.push(`${key}: boolean flag needs envParse (raw env string cannot become a boolean)`);
    return problems;
  }
  for (const raw of GRAMMAR_PROBES) {
    const expected = expectedFromGrammar(grammar, raw);
    const actual = def.envParse(raw);
    if (!Object.is(actual, expected)) {
      problems.push(
        `${key}: envParse(${JSON.stringify(raw)}) = ${JSON.stringify(actual)} but declared grammar yields ${JSON.stringify(expected)}`,
      );
      break;
    }
  }
  return problems;
}

export function metadataProblems(def: ConfigKeyDef, key: string): string[] {
  const problems: string[] = [];
  for (const field of METADATA_FIELDS) {
    const value = def[field];
    if (value === undefined || value === null) {
      problems.push(`${key}: missing ${field}`);
    } else if (field === 'consumers') {
      if (
        !Array.isArray(value) ||
        value.length === 0 ||
        !value.every((item) => typeof item === 'string' && item.trim() !== '')
      ) {
        problems.push(`${key}: consumers must be a non-empty string[]`);
      }
    } else if (typeof value !== 'string' || value.trim() === '') {
      problems.push(`${key}: ${field} must be a non-empty string`);
    }
  }
  return problems;
}

export function controlProblems(def: ConfigKeyDef, key: string, kind: ControlKind): string[] {
  if (kind === 'enum') {
    const options = def.schema instanceof z.ZodEnum ? def.schema.options : undefined;
    if (!options || options.length === 0) return [`${key}: enum control has no options`];
  }
  return [];
}

function sameGrammar(a: FlagGrammarFingerprint | null, b: FlagGrammarFingerprint | null): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function sameEnum(a: string[] | null, b: string[] | null): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Base/head contract drift. Default values and reader sets are reported, never failed. */
export function compareWithBase(
  base: Map<string, DefinitionFingerprint>,
  head: Map<string, DefinitionFingerprint>,
  headDefs: Map<string, HeadDefinition>,
  baseReaders: Map<string, string[]>,
  baseConsts: ConstDefinition[],
  headConsts: ConstDefinition[],
): { violations: FlagViolation[]; diff: DiffEntry[] } {
  const violations: FlagViolation[] = [];
  const diff: DiffEntry[] = [];

  for (const [key, baseDef] of base) {
    const headDef = head.get(key);
    if (!headDef) {
      diff.push({ name: key, field: 'removed', base: baseDef.kind, head: null });
      continue;
    }
    if (baseDef.envName !== headDef.envName) {
      violations.push({
        code: 'BASE-DRIFT',
        name: key,
        detail: `envName changed: base ${JSON.stringify(baseDef.envName)} → head ${JSON.stringify(headDef.envName)}`,
      });
    }
    if (baseDef.envMode !== headDef.envMode) {
      violations.push({
        code: 'BASE-DRIFT',
        name: key,
        detail: `envMode changed: base '${baseDef.envMode}' → head '${headDef.envMode}'`,
      });
    }
    if (baseDef.kind !== headDef.kind) {
      violations.push({
        code: 'BASE-DRIFT',
        name: key,
        detail: `control kind changed: base '${baseDef.kind}' → head '${headDef.kind}'`,
      });
    }
    if (baseDef.flag === null && headDef.flag !== null) {
      diff.push({ name: key, field: 'flag-metadata', base: null, head: headDef.flag });
    } else if (baseDef.flag !== null && headDef.flag === null) {
      // A head extraction problem is already reported; do not fake a grammar change.
      if (!headDef.flagUnresolved) {
        violations.push({
          code: 'BASE-DRIFT',
          name: key,
          detail: 'flag grammar metadata was removed at head',
        });
      }
    } else if (!sameGrammar(baseDef.flag, headDef.flag)) {
      violations.push({
        code: 'BASE-DRIFT',
        name: key,
        detail: `flag grammar changed: base ${JSON.stringify(baseDef.flag)} → head ${JSON.stringify(headDef.flag)}`,
      });
    }
    if (
      baseDef.enumValues !== undefined &&
      headDef.enumValues !== undefined &&
      !sameEnum(baseDef.enumValues, headDef.enumValues)
    ) {
      violations.push({
        code: 'BASE-DRIFT',
        name: key,
        detail: `enum values changed: base ${JSON.stringify(baseDef.enumValues)} → head ${JSON.stringify(headDef.enumValues)}`,
      });
    }
    const before = (baseReaders.get(key) ?? []).join(',');
    const after = (headDefs.get(key)?.readers ?? []).join(',');
    if (before !== after) {
      diff.push({ name: key, field: 'readers', base: before, head: after });
    }
    if (baseDef.codeDefaultUnresolved || headDef.codeDefaultUnresolved) {
      // Not statically comparable; report once instead of fabricating a value change.
      diff.push({
        name: key,
        field: 'codeDefault-unresolved',
        base: baseDef.codeDefaultUnresolved ? 'unresolved' : baseDef.codeDefault,
        head: headDef.codeDefaultUnresolved ? 'unresolved' : headDef.codeDefault,
      });
    } else if (JSON.stringify(baseDef.codeDefault) !== JSON.stringify(headDef.codeDefault)) {
      diff.push({
        name: key,
        field: 'codeDefault',
        base: baseDef.codeDefault ?? null,
        head: headDef.codeDefault ?? null,
      });
    }
  }

  for (const [key, headDef] of head) {
    if (!base.has(key)) {
      diff.push({ name: key, field: 'added', base: null, head: headDef.kind });
    }
  }

  const baseConstByName = new Map(baseConsts.map((entry) => [entry.name, entry]));
  const headConstByName = new Map(headConsts.map((entry) => [entry.name, entry]));
  for (const [name, baseConst] of baseConstByName) {
    const headConst = headConstByName.get(name);
    if (!headConst) {
      diff.push({ name, field: 'const-removed', base: baseConst.value, head: null });
    } else if (baseConst.value !== headConst.value) {
      diff.push({ name, field: 'const-value', base: baseConst.value, head: headConst.value });
    }
  }
  for (const name of headConstByName.keys()) {
    if (!baseConstByName.has(name)) {
      diff.push({ name, field: 'const-added', base: null, head: headConstByName.get(name)?.value });
    }
  }

  return { violations, diff };
}

/** The AST extractor must see exactly what the runtime registry sees at head. */
export function crossCheckHead(
  runtime: HeadDefinition[],
  extraction: FingerprintExtraction,
): FlagViolation[] {
  const violations: FlagViolation[] = [];
  for (const def of runtime) {
    const ast = extraction.fingerprints.get(def.key);
    if (!ast) {
      violations.push({
        code: 'DEFINITION-PROBLEM',
        name: def.key,
        detail: 'AST extractor cannot see this CONFIG_REGISTRY entry',
      });
      continue;
    }
    if (ast.kind !== def.kind) {
      violations.push({
        code: 'DEFINITION-PROBLEM',
        name: def.key,
        detail: `runtime schema kind '${def.kind}' but AST extraction says '${ast.kind}'`,
      });
    }
    if (ast.envName !== def.envName) {
      violations.push({
        code: 'DEFINITION-PROBLEM',
        name: def.key,
        detail: `runtime envName ${JSON.stringify(def.envName)} but AST extraction says ${JSON.stringify(ast.envName)}`,
      });
    }
    if (def.flag && ast.flag) {
      const runtimeGrammar = normalizeGrammar(def.flag);
      if (!sameGrammar(runtimeGrammar, ast.flag)) {
        violations.push({
          code: 'DEFINITION-PROBLEM',
          name: def.key,
          detail: `runtime flag grammar ${JSON.stringify(runtimeGrammar)} but AST extraction says ${JSON.stringify(ast.flag)}`,
        });
      }
    }
    if (def.enumValues && ast.enumValues && !sameEnum(def.enumValues, ast.enumValues)) {
      violations.push({
        code: 'DEFINITION-PROBLEM',
        name: def.key,
        detail: `runtime enum values ${JSON.stringify(def.enumValues)} but AST extraction says ${JSON.stringify(ast.enumValues)}`,
      });
    }
  }
  return violations;
}

// ── registry key census (all keys, not only the family audited above) ───────────────────────

export interface RegistryKeyCensusEntry {
  key: string;
  kind: ControlKind;
  envName: string | null;
}

export interface RegistryKeyCensus {
  entries: Map<string, RegistryKeyCensusEntry>;
  problems: string[];
}

/** All CONFIG_REGISTRY keys at a ref; used for base/head env-name and new-key comparisons. */
export function extractRegistryKeyCensus(sourceText: string): RegistryKeyCensus {
  const ast = parse(sourceText, {
    sourceType: 'module',
    plugins: ['typescript'],
    errorRecovery: true,
  }) as unknown as AstNode;
  const consts = constInitializers(ast);
  let registry: AstNode | undefined;
  walkAst(ast, (node) => {
    if (registry) return;
    if (node.type !== 'VariableDeclarator' || node.id?.type !== 'Identifier') return;
    if (node.id.name !== 'CONFIG_REGISTRY') return;
    const init = node.init ? unwrapExpression(node.init) : undefined;
    if (init?.type === 'ObjectExpression') registry = init;
  });
  const entries = new Map<string, RegistryKeyCensusEntry>();
  const problems: string[] = [];
  if (!registry) return { entries, problems };
  for (const prop of registry.properties ?? []) {
    if (prop.type !== 'ObjectProperty' || prop.computed) {
      problems.push(
        'CONFIG_REGISTRY has a spread/computed entry; keys are not statically decidable',
      );
      continue;
    }
    const key =
      prop.key.type === 'Identifier'
        ? prop.key.name
        : prop.key.type === 'StringLiteral'
          ? prop.key.value
          : undefined;
    if (key === undefined) {
      problems.push('CONFIG_REGISTRY has an entry with a non-static key');
      continue;
    }
    const node = prop.value;
    const envNameNode = objectProperty(node, 'envName');
    const envNameValue = resolveStatic(envNameNode, consts);
    if (envNameNode && envNameValue === UNKNOWN) {
      problems.push(`${key}: envName is not statically decidable`);
    }
    entries.set(key, {
      key,
      kind: schemaKindFromAst(objectProperty(node, 'schema')),
      envName: typeof envNameValue === 'string' ? envNameValue : null,
    });
  }
  return { entries, problems };
}

// ── env census ────────────────────────────────────────────────────────────────────────────

export interface EnvReadLike {
  key: string | null;
  file: string;
}

/** A direct env read that stays outside registry/boot by design, scoped to one owner. */
export interface StayInPlaceEntry {
  env: string;
  /** Repo-relative file, or directory prefix; only this owner may read the name. */
  owner: string;
  reason: string;
}

export interface EnvCensusInput {
  registryEnvs: ReadonlySet<string>;
  baseRegistryEnvs: ReadonlySet<string>;
  bootKeys: ReadonlySet<string>;
  baseBootKeys: ReadonlySet<string>;
  stayInPlace: readonly StayInPlaceEntry[];
  headNamedReads: readonly EnvReadLike[];
  baseNamedReads: readonly EnvReadLike[];
  headDynamicReads: readonly EnvReadLike[];
  baseDynamicReads: readonly EnvReadLike[];
  /** Head path -> path at the comparison base, so a moved file keeps its base grant. */
  baseFileOf: (headFile: string) => string;
  isAllowedDynamicFile: (path: string) => boolean;
}

export interface EnvCensusReport {
  registryEnvCount: number;
  bootKeyCount: number;
  overlapCount: number;
  schemaOnly: string[];
  registryOnly: string[];
  existingRegistryOnly: string[];
  hidden: { key: string; files: string[] }[];
  existingUnclassified: { key: string; file: string }[];
  dynamicByFile: { file: string; count: number }[];
  stayInPlace: StayInPlaceEntry[];
  namedReadCount: number;
  namedFileCount: number;
  namedNameCount: number;
  existingNamedReadCount: number;
  dynamicReadCount: number;
  classified: { registry: number; boot: number; stay: number };
}

type EnvTable = 'registry' | 'boot' | 'stay';

function ownerMatches(owner: string, file: string): boolean {
  return file === owner || file.startsWith(owner.endsWith('/') ? owner : `${owner}/`);
}

function stayEntryFor(
  entries: readonly StayInPlaceEntry[],
  key: string,
  file: string,
): StayInPlaceEntry | undefined {
  return entries.find((entry) => entry.env === key && ownerMatches(entry.owner, file));
}

function tableOf(input: EnvCensusInput, key: string, file: string): EnvTable | null {
  if (stayEntryFor(input.stayInPlace, key, file)) return 'stay';
  if (input.registryEnvs.has(key)) return 'registry';
  if (input.bootKeys.has(key)) return 'boot';
  return null;
}

const READ_POINT_GUIDANCE =
  'boot names must come from the parsed env in src/core/config/server/env.ts, registry keys from getConfig/getConfigFlag/getConfigMany, and provider/third-party credentials or pre-boot reads belong in STAY_IN_PLACE_ENV under their owner';

/**
 * Product env census: new named reads fail regardless of which table the name lives in
 * (boot names included) unless the read sits at a STAY_IN_PLACE_ENV owner; reads present at
 * the base — including the same read inside a renamed file — are grandfathered. New dynamic
 * reads fail by per-file count vs base (rename-aware). The report lists the existing stock.
 */
export function computeEnvCensus(input: EnvCensusInput): {
  report: EnvCensusReport;
  violations: FlagViolation[];
} {
  const violations: FlagViolation[] = [];
  const schemaOnly = [...input.bootKeys].filter((key) => !input.registryEnvs.has(key)).sort();
  const registryOnly = [...input.registryEnvs].filter((key) => !input.bootKeys.has(key)).sort();
  const existingRegistryOnly = registryOnly.filter(
    (env) => input.baseRegistryEnvs.has(env) && !input.baseBootKeys.has(env),
  );
  for (const env of registryOnly) {
    if (existingRegistryOnly.includes(env)) continue;
    violations.push({
      code: 'REGISTRY-SCHEMA-GAP',
      name: env,
      detail:
        'registry envName is missing from the boot schema (src/core/config/server/env.ts); add it to the boot schema or drop the registry envName',
    });
  }

  const stayEnvs = new Set(input.stayInPlace.map((entry) => entry.env));
  const baseNamedIds = new Set(
    input.baseNamedReads.map((read) => `${read.key ?? ''}\u0000${read.file}`),
  );
  const seen = new Set<string>();
  const hiddenFiles = new Map<string, Set<string>>();
  const existingUnclassified: { key: string; file: string }[] = [];
  const classified = { registry: 0, boot: 0, stay: 0 };
  let namedReadCount = 0;
  let existingNamedReadCount = 0;

  for (const read of input.headNamedReads) {
    const key = read.key;
    if (!key) continue;
    const id = `${key}\u0000${read.file}`;
    if (seen.has(id)) continue;
    seen.add(id);
    namedReadCount += 1;

    const table = tableOf(input, key, read.file);
    if (table) classified[table] += 1;

    if (!input.registryEnvs.has(key) && !input.bootKeys.has(key) && !stayEnvs.has(key)) {
      const files = hiddenFiles.get(key) ?? new Set<string>();
      files.add(read.file);
      hiddenFiles.set(key, files);
    }

    const baseFile = input.baseFileOf(read.file);
    if (baseNamedIds.has(`${key}\u0000${baseFile}`)) {
      existingNamedReadCount += 1;
      if (!table) existingUnclassified.push({ key, file: read.file });
      continue;
    }
    if (table === 'stay') continue;
    violations.push({
      code: 'UNCLASSIFIED-ENV-READ',
      name: key,
      detail: `new product-code process.env.${key} read in ${read.file}; ${READ_POINT_GUIDANCE}`,
    });
  }

  const baseDynamicCounts = new Map<string, number>();
  for (const read of input.baseDynamicReads) {
    baseDynamicCounts.set(read.file, (baseDynamicCounts.get(read.file) ?? 0) + 1);
  }
  const headDynamicCounts = new Map<string, number>();
  for (const read of input.headDynamicReads) {
    headDynamicCounts.set(read.file, (headDynamicCounts.get(read.file) ?? 0) + 1);
  }
  const dynamicByFile: { file: string; count: number }[] = [];
  let dynamicReadCount = 0;
  for (const [file, count] of [...headDynamicCounts.entries()].sort((a, b) =>
    a[0].localeCompare(b[0]),
  )) {
    if (input.isAllowedDynamicFile(file)) continue;
    dynamicByFile.push({ file, count });
    dynamicReadCount += count;
    const previous = baseDynamicCounts.get(input.baseFileOf(file)) ?? 0;
    if (count > previous) {
      violations.push({
        code: 'DYNAMIC-ENV-READ',
        name: file,
        detail: `${count} dynamic process.env[...] read(s) at head vs ${previous} at base; ${READ_POINT_GUIDANCE}`,
      });
    }
  }

  const namedFiles = new Set(input.headNamedReads.map((read) => read.file));
  const namedNames = new Set(input.headNamedReads.map((read) => read.key).filter(Boolean));

  return {
    report: {
      registryEnvCount: input.registryEnvs.size,
      bootKeyCount: input.bootKeys.size,
      overlapCount: [...input.registryEnvs].filter((key) => input.bootKeys.has(key)).length,
      schemaOnly,
      registryOnly,
      existingRegistryOnly,
      hidden: [...hiddenFiles.entries()]
        .map(([key, files]) => ({ key, files: [...files].sort() }))
        .sort((a, b) => a.key.localeCompare(b.key)),
      existingUnclassified: existingUnclassified.sort(
        (a, b) => a.key.localeCompare(b.key) || a.file.localeCompare(b.file),
      ),
      dynamicByFile,
      stayInPlace: [...input.stayInPlace].sort(
        (a, b) => a.env.localeCompare(b.env) || a.owner.localeCompare(b.owner),
      ),
      namedReadCount,
      namedFileCount: namedFiles.size,
      namedNameCount: namedNames.size,
      existingNamedReadCount,
      dynamicReadCount,
      classified,
    },
    violations,
  };
}

// ── non-family registry keys (metadata / reader / direct-env checks) ───────────────────────

export interface NonFamilyEntryLike {
  key: string;
  envName: string | null;
  metadataProblems: string[];
  readerCount: number;
}

export interface NonFamilyAuditInput {
  entries: readonly NonFamilyEntryLike[];
  baseKeys: ReadonlySet<string>;
  headReads: readonly { key: string; file: string }[];
  baseReadIds: ReadonlySet<string>;
  isAllowedDirectEnvFile: (path: string) => boolean;
}

export interface NonFamilyReport {
  total: number;
  existingMetadataGaps: { key: string; problems: string[] }[];
  existingNoReader: string[];
  existingDirectReads: { key: string; file: string }[];
}

/**
 * Number/string and env-less json keys skip the family gate; this adds the same
 * metadata / reader / direct-env checks. Existing findings stay report-only; a new key or
 * a new direct read fails.
 */
export function auditNonFamilyKeys(input: NonFamilyAuditInput): {
  report: NonFamilyReport;
  violations: FlagViolation[];
} {
  const violations: FlagViolation[] = [];
  const byKey = new Map(input.entries.map((entry) => [entry.key, entry]));
  const envNameToKeys = new Map<string, string[]>();
  for (const entry of input.entries) {
    if (!entry.envName) continue;
    const list = envNameToKeys.get(entry.envName) ?? [];
    list.push(entry.key);
    envNameToKeys.set(entry.envName, list);
  }
  const existingMetadataGaps: { key: string; problems: string[] }[] = [];
  const existingNoReader: string[] = [];

  for (const entry of input.entries) {
    const isNew = !input.baseKeys.has(entry.key);
    if (entry.metadataProblems.length > 0) {
      if (isNew) {
        for (const problem of entry.metadataProblems) {
          violations.push({
            code: 'DEFINITION-PROBLEM',
            name: entry.key,
            detail: problem.startsWith(`${entry.key}: `)
              ? problem.slice(entry.key.length + 2)
              : problem,
          });
        }
      } else {
        existingMetadataGaps.push({ key: entry.key, problems: entry.metadataProblems });
      }
    }
    if (entry.readerCount === 0) {
      if (isNew) {
        violations.push({
          code: 'NO-READER',
          name: entry.key,
          detail: 'non-family key has no live getConfig/getConfigFlag/getConfigMany reader',
        });
      } else {
        existingNoReader.push(entry.key);
      }
    }
  }

  const existingDirectReads: { key: string; file: string }[] = [];
  for (const read of input.headReads) {
    for (const key of envNameToKeys.get(read.key) ?? []) {
      if (!byKey.has(key)) continue;
      if (input.isAllowedDirectEnvFile(read.file)) continue;
      if (input.baseReadIds.has(`${read.key}\u0000${read.file}`)) {
        existingDirectReads.push({ key, file: read.file });
        continue;
      }
      violations.push({
        code: 'DIRECT-ENV-READ',
        name: key,
        detail: `non-family key read directly from process.env in ${read.file} (${read.key}); use getConfig/getConfigMany`,
      });
    }
  }

  return {
    report: {
      total: input.entries.length,
      existingMetadataGaps: existingMetadataGaps.sort((a, b) => a.key.localeCompare(b.key)),
      existingNoReader: existingNoReader.sort(),
      existingDirectReads: existingDirectReads.sort(
        (a, b) => a.key.localeCompare(b.key) || a.file.localeCompare(b.file),
      ),
    },
    violations,
  };
}

export function computeVariance(
  definitions: HeadDefinition[],
): { signature: string; flags: string[] }[] {
  const bySignature = new Map<string, string[]>();
  for (const def of definitions) {
    if (def.kind !== 'flag' || !def.flag) continue;
    const literals = [...def.flag.trueLiterals]
      .sort()
      .map((literal) => `'${literal}'`)
      .join('|');
    const signature = `true=${literals} false='${[...def.flag.falseLiterals].sort().join("'|'")}' match=${def.flag.caseInsensitive ? 'ci' : 'cs'}`;
    const list = bySignature.get(signature) ?? [];
    list.push(def.key);
    bySignature.set(signature, list);
  }
  return [...bySignature.entries()]
    .map(([signature, flags]) => ({ signature, flags: flags.sort() }))
    .sort((a, b) => a.signature.localeCompare(b.signature));
}
