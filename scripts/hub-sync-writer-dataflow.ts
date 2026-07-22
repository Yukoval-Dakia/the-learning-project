import { parse } from '@babel/parser';

type AstNode = {
  type: string;
  start?: number | null;
  [key: string]: unknown;
};

type Trust = 1 | 2 | 3 | 4 | 5 | 6 | 7;
const U: Trust = 1;
const T: Trust = 2;
const N: Trust = 4;

type Binding = { id: number; name: string; scope: Scope; decl: AstNode };
type AliasParameter = { name: string; defaultType?: AstNode };
type TypeAlias = { id: number; body: AstNode; parameters: AliasParameter[]; scope: Scope };
type Scope = {
  parent?: Scope;
  bindings: Map<string, Binding>;
  types: Map<string, TypeAlias>;
  trustedTypes: Set<string>;
  trustedTypeNamespaces: Set<string>;
  shadowedTypes: Set<string>;
  functionScope: Scope;
};
type State = ReadonlyMap<Binding, Trust>;
type CompletionMap = Map<string | null, State>;
type Flow = {
  normal?: State;
  returns?: State;
  throws?: State;
  breaks: CompletionMap;
  continues: CompletionMap;
};
type EvalResult = { normal?: { state: State; value: Trust }; throws?: State };
type InvocationArgument = {
  value: Trust;
  supplied: boolean;
  undefinedness: 'definite' | 'maybe' | 'no';
};
type EvalCtx = { scope: Scope };
type DrizzleWrite = { index: number; table: string };

const DB_MODULE_ALIAS = '@/db/client';
const DB_TYPE_EXPORTS = new Set(['Db', 'Tx']);
const WRITE_METHODS = new Set(['insert', 'update', 'delete']);

function node(value: unknown): AstNode | undefined {
  return value && typeof value === 'object' && 'type' in value ? (value as AstNode) : undefined;
}

function childNodes(value: unknown): AstNode[] {
  if (Array.isArray(value)) return value.flatMap(childNodes);
  const candidate = node(value);
  return candidate ? [candidate] : [];
}

function identifierName(value: unknown): string | undefined {
  const candidate = node(value);
  return candidate?.type === 'Identifier' ? (candidate.name as string) : undefined;
}

function staticComputedPropertyName(value: unknown): string | undefined {
  const candidate = node(value);
  return candidate?.type === 'StringLiteral' && typeof candidate.value === 'string'
    ? candidate.value
    : undefined;
}

function unwrapExpression(expression: unknown): AstNode | undefined {
  let candidate = node(expression);
  while (
    candidate &&
    [
      'TSAsExpression',
      'TSSatisfiesExpression',
      'TSNonNullExpression',
      'TypeCastExpression',
      'ParenthesizedExpression',
      'TSInstantiationExpression',
    ].includes(candidate.type)
  ) {
    candidate = node(candidate.expression);
  }
  return candidate;
}

function unwrapPattern(pattern: unknown): AstNode | undefined {
  let candidate = node(pattern);
  while (
    candidate?.type === 'AssignmentPattern' ||
    candidate?.type === 'RestElement' ||
    candidate?.type === 'TSParameterProperty'
  ) {
    candidate = node(
      candidate.type === 'AssignmentPattern'
        ? candidate.left
        : candidate.type === 'TSParameterProperty'
          ? candidate.parameter
          : candidate.argument,
    );
  }
  return candidate;
}

function trustJoin(left: Trust, right: Trust): Trust {
  return (left | right) as Trust;
}

function cloneState(state: State): Map<Binding, Trust> {
  return new Map(state);
}

function joinState(...states: Array<State | undefined>): State | undefined {
  const present = states.filter((state): state is State => state !== undefined);
  if (present.length === 0) return undefined;
  const result = new Map<Binding, Trust>();
  for (const state of present) {
    for (const [binding, value] of state) {
      result.set(
        binding,
        result.has(binding) ? trustJoin(result.get(binding) as Trust, value) : value,
      );
    }
  }
  return result;
}

function equalState(left: State | undefined, right: State | undefined): boolean {
  if (!left || !right) return left === right;
  const bindings = new Set([...left.keys(), ...right.keys()]);
  for (const binding of bindings) {
    if ((left.get(binding) ?? U) !== (right.get(binding) ?? U)) return false;
  }
  return true;
}

function load(binding: Binding | undefined, state: State): Trust {
  return binding ? (state.get(binding) ?? U) : U;
}

function store(binding: Binding | undefined, value: Trust, state: State): State {
  if (!binding) return state;
  const next = cloneState(state);
  next.set(binding, value);
  return next;
}

function emptyFlow(normal?: State): Flow {
  return { normal, breaks: new Map(), continues: new Map() };
}

function joinCompletionMaps(...maps: CompletionMap[]): CompletionMap {
  const result: CompletionMap = new Map();
  for (const map of maps) {
    for (const [label, state] of map)
      result.set(label, joinState(result.get(label), state) as State);
  }
  return result;
}

function joinFlow(...flows: Flow[]): Flow {
  return {
    normal: joinState(...flows.map((flow) => flow.normal)),
    returns: joinState(...flows.map((flow) => flow.returns)),
    throws: joinState(...flows.map((flow) => flow.throws)),
    breaks: joinCompletionMaps(...flows.map((flow) => flow.breaks)),
    continues: joinCompletionMaps(...flows.map((flow) => flow.continues)),
  };
}

function addAbrupt(target: Flow, source: Flow): void {
  target.returns = joinState(target.returns, source.returns);
  target.throws = joinState(target.throws, source.throws);
  target.breaks = joinCompletionMaps(target.breaks, source.breaks);
  target.continues = joinCompletionMaps(target.continues, source.continues);
}

function sequenceEval(first: EvalResult, next: (state: State) => EvalResult): EvalResult {
  if (!first.normal) return { throws: first.throws };
  const second = next(first.normal.state);
  return { normal: second.normal, throws: joinState(first.throws, second.throws) };
}

function isRepoDbModule(source: string, file: string): boolean {
  if (source === DB_MODULE_ALIAS) return true;
  if (!source.startsWith('.')) return false;
  const slash = file.lastIndexOf('/');
  const base = slash === -1 ? '' : file.slice(0, slash);
  const parts = `${base}/${source}`.split('/');
  const normalized: string[] = [];
  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part === '..') normalized.pop();
    else normalized.push(part);
  }
  const resolved = normalized.join('/');
  return resolved === 'src/db/client' || resolved === 'src/db/client.ts';
}

export function collectDrizzleWrites(source: string, file: string): DrizzleWrite[] {
  let program: AstNode;
  try {
    program = parse(source, {
      sourceType: 'module',
      plugins: ['typescript', 'jsx'],
      errorRecovery: false,
      attachComment: false,
    }).program as unknown as AstNode;
  } catch (error) {
    throw new Error(
      `audit:hub-sync-writers: cannot parse ${file}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  let nextBindingId = 1;
  let nextAliasId = 1;
  const writes = new Map<string, DrizzleWrite>();
  const scopeCache = new WeakMap<AstNode, Scope>();
  const analyzedFunctions = new WeakMap<AstNode, State>();
  const functionBindings = new Map<Binding, AstNode>();
  const staticStrings = new Map<Binding, string>();
  const pendingFunctions: Array<{ candidate: AstNode; parent: Scope; state: State }> = [];
  const pendingFunctionNodes = new WeakSet<AstNode>();
  const deferFunction = (candidate: AstNode, parent: Scope, state: State): void => {
    if (pendingFunctionNodes.has(candidate)) return;
    pendingFunctionNodes.add(candidate);
    pendingFunctions.push({ candidate, parent, state });
  };

  const root = {} as Scope;
  root.bindings = new Map();
  root.types = new Map();
  root.trustedTypes = new Set();
  root.trustedTypeNamespaces = new Set();
  root.shadowedTypes = new Set();
  root.functionScope = root;

  const makeScope = (owner: AstNode, parent: Scope, isFunction = false): Scope => {
    const cached = scopeCache.get(owner);
    if (cached) return cached;
    const scope: Scope = {
      parent,
      bindings: new Map(),
      types: new Map(),
      trustedTypes: new Set(),
      trustedTypeNamespaces: new Set(),
      shadowedTypes: new Set(),
      functionScope: parent.functionScope,
    };
    if (isFunction) scope.functionScope = scope;
    scopeCache.set(owner, scope);
    return scope;
  };

  const ensureBinding = (name: string, scope: Scope, decl: AstNode): Binding => {
    const existing = scope.bindings.get(name);
    if (existing) return existing;
    const binding = { id: nextBindingId++, name, scope, decl };
    scope.bindings.set(name, binding);
    return binding;
  };

  const resolveBinding = (name: string, scope: Scope): Binding | undefined => {
    for (let current: Scope | undefined = scope; current; current = current.parent) {
      const binding = current.bindings.get(name);
      if (binding) return binding;
    }
    return undefined;
  };

  const declarePattern = (pattern: unknown, scope: Scope): void => {
    const candidate = node(pattern);
    if (!candidate) return;
    if (candidate.type === 'Identifier') {
      ensureBinding(candidate.name as string, scope, candidate);
      return;
    }
    if (candidate.type === 'TSParameterProperty') {
      declarePattern(candidate.parameter, scope);
      return;
    }
    if (candidate.type === 'RestElement') {
      declarePattern(candidate.argument, scope);
      return;
    }
    if (candidate.type === 'AssignmentPattern') {
      declarePattern(candidate.left, scope);
      return;
    }
    if (candidate.type === 'ObjectPattern') {
      for (const property of childNodes(candidate.properties)) {
        declarePattern(property.type === 'RestElement' ? property.argument : property.value, scope);
      }
      return;
    }
    if (candidate.type === 'ArrayPattern') {
      for (const element of childNodes(candidate.elements)) declarePattern(element, scope);
    }
  };

  const typeParameterName = (value: unknown): string | undefined => {
    const candidate = node(value);
    if (!candidate) return undefined;
    if (typeof candidate.name === 'string') return candidate.name;
    return identifierName(candidate.name ?? candidate);
  };

  const predeclareImmediate = (statements: unknown, scope: Scope): void => {
    for (const statement of childNodes(statements)) {
      if (statement.type === 'VariableDeclaration' && statement.kind !== 'var') {
        for (const declaration of childNodes(statement.declarations))
          declarePattern(declaration.id, scope);
      } else if (
        statement.type === 'FunctionDeclaration' ||
        statement.type === 'ClassDeclaration'
      ) {
        const name = identifierName(statement.id);
        if (name) ensureBinding(name, scope, statement);
      } else if (statement.type === 'TSTypeAliasDeclaration') {
        const name = identifierName(statement.id);
        const body = node(statement.typeAnnotation);
        if (!name || !body || scope.types.has(name)) continue;
        const parameters = childNodes(node(statement.typeParameters)?.params)
          .map((parameter) => {
            const parameterName = typeParameterName(parameter);
            if (!parameterName) return undefined;
            const defaultType = node(parameter.default);
            return defaultType ? { name: parameterName, defaultType } : { name: parameterName };
          })
          .filter((parameter): parameter is AliasParameter => parameter !== undefined);
        scope.types.set(name, { id: nextAliasId++, body, parameters, scope });
      }
    }
  };

  const predeclareVars = (value: unknown, functionScope: Scope): void => {
    for (const candidate of childNodes(value)) {
      if (
        [
          'FunctionDeclaration',
          'FunctionExpression',
          'ArrowFunctionExpression',
          'ObjectMethod',
          'ClassMethod',
          'ClassPrivateMethod',
          'ClassDeclaration',
          'ClassExpression',
        ].includes(candidate.type)
      )
        continue;
      if (candidate.type === 'VariableDeclaration' && candidate.kind === 'var') {
        for (const declaration of childNodes(candidate.declarations))
          declarePattern(declaration.id, functionScope);
      }
      for (const [key, child] of Object.entries(candidate)) {
        if (key === 'loc' || key === 'start' || key === 'end') continue;
        predeclareVars(child, functionScope);
      }
    }
  };

  type Substitutions = Map<string, AstNode | undefined>;
  const trustedType = (
    typeValue: unknown,
    scope: Scope,
    substitutions: Substitutions = new Map(),
    seen = new Set<string>(),
  ): boolean => {
    const candidate = node(typeValue);
    if (!candidate) return false;
    if (candidate.type === 'TSTypeAnnotation')
      return trustedType(candidate.typeAnnotation, scope, substitutions, seen);
    if (candidate.type === 'TSParenthesizedType' || candidate.type === 'TSOptionalType')
      return trustedType(candidate.typeAnnotation, scope, substitutions, seen);
    if (candidate.type === 'TSUnionType') {
      return childNodes(candidate.types).every((part) =>
        ['TSNullKeyword', 'TSUndefinedKeyword', 'TSNeverKeyword'].includes(part.type) ||
        (part.type === 'TSLiteralType' && node(part.literal)?.type === 'NullLiteral')
          ? true
          : trustedType(part, scope, substitutions, new Set(seen)),
      );
    }
    if (candidate.type === 'TSIntersectionType') {
      return childNodes(candidate.types).some((part) =>
        trustedType(part, scope, substitutions, new Set(seen)),
      );
    }
    if (candidate.type === 'TSTypeQuery') {
      const name = identifierName(candidate.exprName);
      return name ? load(resolveBinding(name, scope), initialState) === T : false;
    }
    if (candidate.type !== 'TSTypeReference') return false;
    const qualified = node(candidate.typeName);
    if (qualified?.type === 'TSQualifiedName') {
      const namespace = identifierName(qualified.left);
      const terminal = identifierName(qualified.right);
      if (!namespace || !terminal || !DB_TYPE_EXPORTS.has(terminal)) return false;
      for (let current: Scope | undefined = scope; current; current = current.parent) {
        if (current.shadowedTypes.has(namespace)) return false;
        if (current.bindings.has(namespace)) return current.trustedTypeNamespaces.has(namespace);
      }
      return false;
    }
    const name = identifierName(qualified);
    if (!name) return false;
    if (substitutions.has(name)) {
      const replacement = substitutions.get(name);
      return replacement ? trustedType(replacement, scope, substitutions, seen) : false;
    }
    for (let current: Scope | undefined = scope; current; current = current.parent) {
      if (current.shadowedTypes.has(name)) return false;
      if (current.trustedTypes.has(name)) return true;
      const alias = current.types.get(name);
      if (!alias) continue;
      const arguments_ = childNodes(node(candidate.typeParameters)?.params);
      const local = new Map(substitutions);
      const actualKey: string[] = [];
      for (const [index, parameter] of alias.parameters.entries()) {
        const explicit = arguments_[index];
        const actual = explicit ?? parameter.defaultType;
        local.set(parameter.name, actual);
        actualKey.push(actual ? `${actual.type}:${actual.start ?? ''}` : '?');
      }
      const key = `${alias.id}<${actualKey.join(',')}>`;
      if (seen.has(key)) return false;
      const nextSeen = new Set(seen);
      nextSeen.add(key);
      return trustedType(alias.body, alias.scope, local, nextSeen);
    }
    return false;
  };

  const establishImport = (candidate: AstNode, scope: Scope, state: State): State => {
    const sourceValue = node(candidate.source)?.value;
    const trustedModule = typeof sourceValue === 'string' && isRepoDbModule(sourceValue, file);
    let next = state;
    for (const specifier of childNodes(candidate.specifiers)) {
      const local = identifierName(specifier.local);
      if (!local) continue;
      const binding = ensureBinding(local, scope, specifier);
      next = store(binding, U, next);
      if (!trustedModule) continue;
      if (specifier.type === 'ImportNamespaceSpecifier') {
        scope.trustedTypeNamespaces.add(local);
      } else if (specifier.type === 'ImportSpecifier') {
        const imported = identifierName(specifier.imported);
        if (imported === 'db') next = store(binding, T, next);
        else if (imported && DB_TYPE_EXPORTS.has(imported)) scope.trustedTypes.add(local);
      }
    }
    return next;
  };

  let initialState: State = new Map();

  const tableArgumentName = (value: unknown): string | undefined => {
    const candidate = unwrapExpression(value);
    if (!candidate) return undefined;
    if (candidate.type === 'SequenceExpression') {
      const expressions = childNodes(candidate.expressions);
      return tableArgumentName(expressions.at(-1));
    }
    if (candidate.type === 'AssignmentExpression') return tableArgumentName(candidate.right);
    return identifierName(candidate);
  };

  const staticStringValue = (value: unknown, scope: Scope): string | undefined => {
    const candidate = unwrapExpression(value);
    if (!candidate) return undefined;
    if (candidate.type === 'StringLiteral' && typeof candidate.value === 'string')
      return candidate.value;
    if (candidate.type === 'TemplateLiteral' && childNodes(candidate.expressions).length === 0) {
      const quasi = childNodes(candidate.quasis)[0];
      const value = quasi?.value;
      const cooked =
        value && typeof value === 'object' ? (value as { cooked?: unknown }).cooked : undefined;
      return typeof cooked === 'string' ? cooked : undefined;
    }
    if (candidate.type === 'Identifier') {
      const binding = resolveBinding(candidate.name as string, scope);
      return binding ? staticStrings.get(binding) : undefined;
    }
    return undefined;
  };

  const reportWrite = (candidate: AstNode, receiver: Trust, method: string | undefined): void => {
    if (!(receiver & T) || !method || !WRITE_METHODS.has(method) || candidate.start == null) return;
    const tableName = tableArgumentName(childNodes(candidate.arguments)[0]);
    if (!tableName) return;
    writes.set(`${candidate.start}:${tableName}`, { index: candidate.start, table: tableName });
  };

  const reportRawExecute = (
    candidate: AstNode,
    receiver: Trust,
    method: string | undefined,
    scope: Scope,
  ): void => {
    if (!(receiver & T) || method !== 'execute' || candidate.start == null) return;
    const rawCall = unwrapExpression(childNodes(candidate.arguments)[0]);
    const rawCallee = rawCall && unwrapExpression(rawCall.callee);
    if (
      rawCall?.type !== 'CallExpression' ||
      rawCallee?.type !== 'MemberExpression' ||
      rawCallee.computed ||
      identifierName(rawCallee.object) !== 'sql' ||
      identifierName(rawCallee.property) !== 'raw'
    )
      return;
    const text = staticStringValue(childNodes(rawCall.arguments)[0], scope);
    if (!text) return;
    for (const table of ['hub_sync_reconciliation', 'knowledge', 'knowledge_edge']) {
      const pattern = new RegExp(
        `\\b(?:update|insert\\s+into|delete\\s+from)\\s+"?${table}\\b`,
        'i',
      );
      if (pattern.test(text))
        writes.set(`${candidate.start}:${table}`, { index: candidate.start, table });
    }
  };

  const evalList = (values: unknown, ctx: EvalCtx, state: State): EvalResult => {
    let result: EvalResult = { normal: { state, value: U } };
    for (const value of childNodes(values)) {
      result = sequenceEval(result, (next) => evalExpr(value, ctx, next));
    }
    return result;
  };

  const evalMember = (candidate: AstNode, ctx: EvalCtx, state: State): EvalResult => {
    const object = node(candidate.object);
    if (!object) return { normal: { state, value: U } };
    let result = evalExpr(object, ctx, state);
    if (candidate.computed) {
      const property = node(candidate.property);
      if (property) result = sequenceEval(result, (next) => evalExpr(property, ctx, next));
    }
    if (!result.normal) return result;
    return {
      normal: { state: result.normal.state, value: U },
      throws: joinState(result.throws, result.normal.state),
    };
  };

  const evalPattern = (
    pattern: unknown,
    value: Trust,
    ctx: EvalCtx,
    state: State,
    declarationScope?: Scope,
  ): EvalResult => {
    const candidate = node(pattern);
    if (!candidate) return { normal: { state, value } };
    if (candidate.type === 'TSParameterProperty')
      return evalPattern(candidate.parameter, value, ctx, state, declarationScope);
    if (candidate.type === 'Identifier') {
      const binding = declarationScope
        ? ensureBinding(candidate.name as string, declarationScope, candidate)
        : resolveBinding(candidate.name as string, ctx.scope);
      return { normal: { state: store(binding, value, state), value } };
    }
    if (candidate.type === 'RestElement')
      return evalPattern(candidate.argument, value, ctx, state, declarationScope);
    if (candidate.type === 'AssignmentPattern') {
      const fallback = node(candidate.right);
      const fallbackResult = fallback ? evalExpr(fallback, ctx, state) : undefined;
      const mergedValue = fallbackResult?.normal
        ? trustJoin(value, fallbackResult.normal.value)
        : value;
      const mergedState = joinState(state, fallbackResult?.normal?.state) as State;
      const stored = evalPattern(candidate.left, mergedValue, ctx, mergedState, declarationScope);
      return { normal: stored.normal, throws: joinState(fallbackResult?.throws, stored.throws) };
    }
    if (candidate.type === 'ObjectPattern') {
      let result: EvalResult = { normal: { state, value } };
      for (const property of childNodes(candidate.properties)) {
        result = sequenceEval(result, (next) => {
          let keyed: EvalResult = { normal: { state: next, value: U } };
          if (property.computed) {
            const key = node(property.key);
            if (key) keyed = evalExpr(key, ctx, next);
          }
          const propertyName = property.computed
            ? staticComputedPropertyName(property.key)
            : identifierName(property.key);
          const propertyValue = value & N && propertyName === 'db' ? T : U;
          return sequenceEval(keyed, (afterKey) =>
            evalPattern(
              property.type === 'RestElement' ? property.argument : property.value,
              propertyValue,
              ctx,
              afterKey,
              declarationScope,
            ),
          );
        });
      }
      return result;
    }
    if (candidate.type === 'ArrayPattern') {
      let result: EvalResult = { normal: { state, value } };
      for (const element of childNodes(candidate.elements)) {
        result = sequenceEval(result, (next) =>
          evalPattern(element, U, ctx, next, declarationScope),
        );
      }
      return result;
    }
    return failExecutable(candidate, 'binding pattern');
  };

  const evalReference = (target: AstNode, ctx: EvalCtx, state: State): EvalResult => {
    const unwrapped = unwrapExpression(target) ?? target;
    if (unwrapped.type === 'Identifier')
      return {
        normal: { state, value: load(resolveBinding(unwrapped.name as string, ctx.scope), state) },
      };
    if (unwrapped.type === 'MemberExpression' || unwrapped.type === 'OptionalMemberExpression')
      return evalMember(unwrapped, ctx, state);
    if (unwrapped.type === 'ObjectPattern' || unwrapped.type === 'ArrayPattern')
      return { normal: { state, value: U } };
    return evalExpr(unwrapped, ctx, state);
  };

  const evalCall = (candidate: AstNode, ctx: EvalCtx, state: State): EvalResult => {
    const callee = unwrapExpression(candidate.callee);
    const member =
      callee && ['MemberExpression', 'OptionalMemberExpression'].includes(callee.type)
        ? callee
        : undefined;
    let calleeResult: EvalResult;
    let directFunction: AstNode | undefined;
    let receiver: Trust = U;
    let method: string | undefined;
    if (member) {
      const object = node(member.object);
      calleeResult = object ? evalExpr(object, ctx, state) : { normal: { state, value: U } };
      if (calleeResult.normal) receiver = calleeResult.normal.value;
      if (member.computed) {
        const property = node(member.property);
        method = staticComputedPropertyName(property);
        if (property)
          calleeResult = sequenceEval(calleeResult, (next) => evalExpr(property, ctx, next));
      } else method = identifierName(member.property);
    } else {
      calleeResult = callee ? evalExpr(callee, ctx, state) : { normal: { state, value: U } };
      const calleeName = identifierName(callee);
      const calleeBinding = calleeName ? resolveBinding(calleeName, ctx.scope) : undefined;
      const functionNode = calleeBinding ? functionBindings.get(calleeBinding) : undefined;
      if (
        callee &&
        ['ArrowFunctionExpression', 'FunctionExpression'].includes(callee.type) &&
        calleeResult.normal
      )
        directFunction = callee;
      else if (functionNode && calleeResult.normal)
        visitFunction(
          functionNode,
          functionNode === callee ? ctx.scope : functionBindingsScope(functionNode),
          calleeResult.normal.state,
          false,
        );
    }
    if (!calleeResult.normal) return calleeResult;
    reportWrite(candidate, receiver, method);
    reportRawExecute(candidate, receiver, method, ctx.scope);
    const callFrontier = calleeResult.normal.state;
    let argumentsResult: EvalResult = calleeResult;
    const invocationArguments: InvocationArgument[] = [];
    const args = childNodes(candidate.arguments);
    for (const [index, argument] of args.entries()) {
      argumentsResult = sequenceEval(argumentsResult, (next) => {
        const callback = unwrapExpression(argument);
        if (
          method === 'transaction' &&
          receiver & T &&
          callback &&
          ['ArrowFunctionExpression', 'FunctionExpression'].includes(callback.type)
        ) {
          visitFunction(callback, ctx.scope, next, true);
          invocationArguments.push({ value: U, supplied: true, undefinedness: 'no' });
          return { normal: { state: next, value: U } };
        }
        const evaluated = evalExpr(argument, ctx, next);
        if (evaluated.normal) {
          const expression = unwrapExpression(argument);
          const undefinedness =
            expression?.type === 'Identifier' && expression.name === 'undefined'
              ? 'definite'
              : expression?.type === 'UnaryExpression' && expression.operator === 'void'
                ? 'definite'
                : expression &&
                    ['ConditionalExpression', 'LogicalExpression'].includes(expression.type)
                  ? 'maybe'
                  : 'no';
          invocationArguments.push({
            value: evaluated.normal.value,
            supplied: true,
            undefinedness,
          });
        }
        return evaluated;
      });
      if (!argumentsResult.normal) break;
      if (index === args.length - 1) break;
    }
    if (!argumentsResult.normal) return argumentsResult;
    const after = argumentsResult.normal.state;
    if (directFunction) {
      const invoked = invokeDirectFunction(directFunction, ctx.scope, after, invocationArguments);
      return {
        normal: invoked.normal && { state: invoked.normal.state, value: U },
        throws: joinState(argumentsResult.throws, invoked.throws),
      };
    }
    return {
      normal: { state: after, value: U },
      throws: joinState(argumentsResult.throws, callFrontier, after),
    };
  };

  const evalAssignment = (candidate: AstNode, ctx: EvalCtx, state: State): EvalResult => {
    const left = node(candidate.left);
    const right = node(candidate.right);
    if (!left || !right) return { normal: { state, value: U } };
    const reference = evalReference(left, ctx, state);
    if (!reference.normal) return reference;
    const operator = candidate.operator as string;
    const assign = (input: State, value: Trust): EvalResult => {
      const target = unwrapExpression(left) ?? left;
      if (target.type === 'Identifier') {
        return {
          normal: {
            state: store(resolveBinding(target.name as string, ctx.scope), value, input),
            value,
          },
        };
      }
      if (target.type === 'ObjectPattern' || target.type === 'ArrayPattern')
        return evalPattern(target, value, ctx, input);
      return { normal: { state: input, value } };
    };
    if (operator === '=') {
      const target = unwrapExpression(left) ?? left;
      const functionValue = unwrapExpression(right);
      if (
        target.type === 'Identifier' &&
        functionValue &&
        ['FunctionExpression', 'ArrowFunctionExpression'].includes(functionValue.type)
      ) {
        const binding = resolveBinding(target.name as string, ctx.scope);
        if (binding) functionBindings.set(binding, functionValue);
        functionParents.set(functionValue, ctx.scope);
        deferFunction(functionValue, ctx.scope, reference.normal.state);
      }
      const rhs = evalExpr(right, ctx, reference.normal.state);
      if (!rhs.normal) return { throws: joinState(reference.throws, rhs.throws) };
      const stored = assign(rhs.normal.state, rhs.normal.value);
      return {
        normal: stored.normal,
        throws: joinState(reference.throws, rhs.throws, stored.throws),
      };
    }
    if (['&&=', '||=', '??='].includes(operator)) {
      const skip = assign(reference.normal.state, reference.normal.value);
      const rhs = evalExpr(right, ctx, reference.normal.state);
      const taken: EvalResult = rhs.normal ? assign(rhs.normal.state, rhs.normal.value) : {};
      return {
        normal: joinState(skip.normal?.state, taken.normal?.state) && {
          state: joinState(skip.normal?.state, taken.normal?.state) as State,
          value: trustJoin(skip.normal?.value ?? U, taken.normal?.value ?? U),
        },
        throws: joinState(reference.throws, rhs.throws, taken.throws),
      };
    }
    const rhs = evalExpr(right, ctx, reference.normal.state);
    if (!rhs.normal) return { throws: joinState(reference.throws, rhs.throws) };
    const stored = assign(rhs.normal.state, U);
    return {
      normal: stored.normal,
      throws: joinState(reference.throws, rhs.throws, stored.throws),
    };
  };

  const evalExpr = (candidate: AstNode, ctx: EvalCtx, state: State): EvalResult => {
    const transparent = unwrapExpression(candidate);
    if (transparent && transparent !== candidate) return evalExpr(transparent, ctx, state);
    switch (candidate.type) {
      case 'Identifier':
        return {
          normal: {
            state,
            value: load(resolveBinding(candidate.name as string, ctx.scope), state),
          },
        };
      case 'ThisExpression':
      case 'Super':
      case 'NullLiteral':
      case 'BooleanLiteral':
      case 'NumericLiteral':
      case 'BigIntLiteral':
      case 'DecimalLiteral':
      case 'StringLiteral':
      case 'RegExpLiteral':
      case 'JSXElement':
      case 'JSXFragment':
        return { normal: { state, value: U } };
      case 'MemberExpression':
      case 'OptionalMemberExpression': {
        const taken = evalMember(candidate, ctx, state);
        if (!candidate.optional) return taken;
        return {
          normal: taken.normal && {
            state: joinState(state, taken.normal.state) as State,
            value: U,
          },
          throws: taken.throws,
        };
      }
      case 'CallExpression':
      case 'OptionalCallExpression': {
        const callee = unwrapExpression(candidate.callee);
        if (callee?.type === 'Import') {
          const source = childNodes(candidate.arguments)[0];
          const sourceValue = source?.type === 'StringLiteral' ? source.value : undefined;
          const evaluated = source ? evalExpr(source, ctx, state) : { normal: { state, value: U } };
          if (!evaluated.normal) return evaluated;
          return {
            normal: {
              state: evaluated.normal.state,
              value: typeof sourceValue === 'string' && isRepoDbModule(sourceValue, file) ? N : U,
            },
            throws: joinState(evaluated.throws, evaluated.normal.state),
          };
        }
        const taken = evalCall(candidate, ctx, state);
        if (!candidate.optional) return taken;
        return {
          normal: taken.normal && {
            state: joinState(state, taken.normal.state) as State,
            value: U,
          },
          throws: taken.throws,
        };
      }
      case 'AssignmentExpression':
        return evalAssignment(candidate, ctx, state);
      case 'UpdateExpression': {
        const argument = node(candidate.argument);
        if (!argument) return { normal: { state, value: U } };
        const reference = evalReference(argument, ctx, state);
        if (!reference.normal) return reference;
        const target = unwrapExpression(argument) ?? argument;
        const next =
          target.type === 'Identifier'
            ? store(resolveBinding(target.name as string, ctx.scope), U, reference.normal.state)
            : reference.normal.state;
        return { normal: { state: next, value: U }, throws: reference.throws };
      }
      case 'SequenceExpression':
        return evalList(candidate.expressions, ctx, state);
      case 'AwaitExpression':
      case 'YieldExpression': {
        const argument = node(candidate.argument);
        const result = argument ? evalExpr(argument, ctx, state) : { normal: { state, value: U } };
        return result.normal
          ? { normal: result.normal, throws: joinState(result.throws, result.normal.state) }
          : result;
      }
      case 'SpreadElement': {
        const argument = node(candidate.argument);
        return argument ? evalExpr(argument, ctx, state) : { normal: { state, value: U } };
      }
      case 'UnaryExpression': {
        const argument = node(candidate.argument ?? candidate.expression);
        return argument
          ? sequenceEval(evalExpr(argument, ctx, state), (next) => ({
              normal: { state: next, value: U },
            }))
          : { normal: { state, value: U } };
      }
      case 'BinaryExpression':
      case 'PipelineTopicExpression': {
        const left = node(candidate.left);
        const right = node(candidate.right);
        let result = left ? evalExpr(left, ctx, state) : { normal: { state, value: U } };
        if (right) result = sequenceEval(result, (next) => evalExpr(right, ctx, next));
        return result.normal
          ? { normal: { state: result.normal.state, value: U }, throws: result.throws }
          : result;
      }
      case 'LogicalExpression': {
        const left = node(candidate.left);
        const right = node(candidate.right);
        if (!left || !right) return { normal: { state, value: U } };
        const first = evalExpr(left, ctx, state);
        if (!first.normal) return first;
        const second = evalExpr(right, ctx, first.normal.state);
        const normal = joinState(first.normal.state, second.normal?.state);
        return {
          normal: normal && {
            state: normal,
            value: trustJoin(first.normal.value, second.normal?.value ?? U),
          },
          throws: joinState(first.throws, second.throws),
        };
      }
      case 'ConditionalExpression': {
        const test = node(candidate.test);
        const consequent = node(candidate.consequent);
        const alternate = node(candidate.alternate);
        const tested = test ? evalExpr(test, ctx, state) : { normal: { state, value: U } };
        if (!tested.normal) return tested;
        const yes = consequent
          ? evalExpr(consequent, ctx, tested.normal.state)
          : { normal: { state: tested.normal.state, value: U } };
        const no = alternate
          ? evalExpr(alternate, ctx, tested.normal.state)
          : { normal: { state: tested.normal.state, value: U } };
        const normal = joinState(yes.normal?.state, no.normal?.state);
        return {
          normal: normal && {
            state: normal,
            value: trustJoin(yes.normal?.value ?? U, no.normal?.value ?? U),
          },
          throws: joinState(tested.throws, yes.throws, no.throws),
        };
      }
      case 'ArrayExpression':
        return evalList(candidate.elements, ctx, state);
      case 'ObjectExpression': {
        let result: EvalResult = { normal: { state, value: U } };
        for (const property of childNodes(candidate.properties)) {
          result = sequenceEval(result, (next) => {
            let current: EvalResult = { normal: { state: next, value: U } };
            if (property.computed) {
              const key = node(property.key);
              if (key) current = evalExpr(key, ctx, next);
            }
            const value = node(property.value ?? property.argument);
            if (value)
              current = sequenceEval(current, (afterKey) => evalExpr(value, ctx, afterKey));
            if (['ObjectMethod'].includes(property.type) && current.normal)
              visitFunction(property, ctx.scope, current.normal.state, false);
            return current;
          });
        }
        return result.normal
          ? { normal: { state: result.normal.state, value: U }, throws: result.throws }
          : result;
      }
      case 'TemplateLiteral':
        return evalList(candidate.expressions, ctx, state);
      case 'TaggedTemplateExpression': {
        const tag = node(candidate.tag);
        const quasi = node(candidate.quasi);
        let result = tag ? evalExpr(tag, ctx, state) : { normal: { state, value: U } };
        if (quasi) result = sequenceEval(result, (next) => evalExpr(quasi, ctx, next));
        return result.normal
          ? {
              normal: { state: result.normal.state, value: U },
              throws: joinState(result.throws, result.normal.state),
            }
          : result;
      }
      case 'NewExpression': {
        const callee = node(candidate.callee);
        let result = callee ? evalExpr(callee, ctx, state) : { normal: { state, value: U } };
        result = sequenceEval(result, (next) => evalList(candidate.arguments, ctx, next));
        return result.normal
          ? {
              normal: { state: result.normal.state, value: U },
              throws: joinState(result.throws, result.normal.state),
            }
          : result;
      }
      case 'FunctionExpression':
      case 'ArrowFunctionExpression':
        functionParents.set(candidate, ctx.scope);
        return { normal: { state, value: U } };
      case 'ClassExpression':
        return evalClass(candidate, ctx, state);
      case 'MetaProperty':
      case 'Import':
        return { normal: { state, value: U } };
      default:
        return failExecutable(candidate, 'expression');
    }
  };

  const execList = (statements: unknown, ctx: EvalCtx, state: State): Flow => {
    const result = emptyFlow(state);
    for (const statement of childNodes(statements)) {
      if (!result.normal) break;
      const current = execStmt(statement, ctx, result.normal);
      result.normal = current.normal;
      addAbrupt(result, current);
    }
    return result;
  };

  type LoopLabels = readonly string[];
  const consumeLoopCompletions = (
    flow: Flow,
    labels: LoopLabels,
  ): { backedge?: State; exit?: State; rest: Flow } => {
    const backedge = joinState(
      flow.normal,
      flow.continues.get(null),
      ...labels.map((label) => flow.continues.get(label)),
    );
    const exit = joinState(flow.breaks.get(null), ...labels.map((label) => flow.breaks.get(label)));
    const breaks = new Map(flow.breaks);
    const continues = new Map(flow.continues);
    breaks.delete(null);
    continues.delete(null);
    for (const label of labels) {
      breaks.delete(label);
      continues.delete(label);
    }
    return {
      backedge,
      exit,
      rest: { returns: flow.returns, throws: flow.throws, breaks, continues },
    };
  };

  const execWhile = (
    candidate: AstNode,
    ctx: EvalCtx,
    entry: State,
    labels: LoopLabels,
    doFirst: boolean,
  ): Flow => {
    const test = node(candidate.test);
    const body = node(candidate.body);
    let header: State = entry;
    const accumulated = emptyFlow();
    let exit: State | undefined;
    for (;;) {
      const tested = test ? evalExpr(test, ctx, header) : { normal: { state: header, value: U } };
      accumulated.throws = joinState(accumulated.throws, tested.throws);
      if (!tested.normal || !body) break;
      exit = joinState(exit, tested.normal.state);
      const bodyFlow = execStmt(body, ctx, tested.normal.state, labels);
      const consumed = consumeLoopCompletions(bodyFlow, labels);
      addAbrupt(accumulated, consumed.rest);
      exit = joinState(exit, consumed.exit);
      const nextHeader = joinState(entry, consumed.backedge) as State;
      if (equalState(nextHeader, header)) break;
      header = nextHeader;
    }
    accumulated.normal = exit;
    return accumulated;
  };

  const execFor = (candidate: AstNode, ctx: EvalCtx, entry: State, labels: LoopLabels): Flow => {
    const loopScope = makeScope(candidate, ctx.scope);
    const loopCtx = { scope: loopScope };
    const init = node(candidate.init);
    let initialized = entry;
    const abrupt = emptyFlow();
    if (init) {
      const initResult =
        init.type === 'VariableDeclaration' ? execStmt(init, loopCtx, entry) : undefined;
      if (initResult) {
        initialized = initResult.normal ?? entry;
        addAbrupt(abrupt, initResult);
      } else {
        const evaluated = evalExpr(init, loopCtx, entry);
        if (!evaluated.normal)
          return { ...abrupt, throws: joinState(abrupt.throws, evaluated.throws) };
        initialized = evaluated.normal.state;
        abrupt.throws = joinState(abrupt.throws, evaluated.throws);
      }
    }
    let header = initialized;
    let exit: State | undefined;
    for (;;) {
      const test = node(candidate.test);
      const tested = test
        ? evalExpr(test, loopCtx, header)
        : { normal: { state: header, value: U } };
      abrupt.throws = joinState(abrupt.throws, tested.throws);
      if (!tested.normal) break;
      if (test) exit = joinState(exit, tested.normal.state);
      const body = node(candidate.body);
      const bodyFlow = body
        ? execStmt(body, loopCtx, tested.normal.state, labels)
        : emptyFlow(tested.normal.state);
      const consumed = consumeLoopCompletions(bodyFlow, labels);
      addAbrupt(abrupt, consumed.rest);
      exit = joinState(exit, consumed.exit);
      let backedge = consumed.backedge;
      const update = node(candidate.update);
      if (backedge && update) {
        const updated = evalExpr(update, loopCtx, backedge);
        abrupt.throws = joinState(abrupt.throws, updated.throws);
        backedge = updated.normal?.state;
      }
      const nextHeader = joinState(initialized, backedge) as State;
      if (equalState(nextHeader, header)) break;
      header = nextHeader;
    }
    abrupt.normal = exit;
    return abrupt;
  };

  const execForEach = (
    candidate: AstNode,
    ctx: EvalCtx,
    entry: State,
    labels: LoopLabels,
  ): Flow => {
    const loopScope = makeScope(candidate, ctx.scope);
    const loopCtx = { scope: loopScope };
    const right = node(candidate.right);
    const rhs = right ? evalExpr(right, loopCtx, entry) : { normal: { state: entry, value: U } };
    const result = emptyFlow(rhs.normal?.state);
    result.throws = rhs.throws;
    if (!rhs.normal) return result;
    const base = rhs.normal.state;
    let header = base;
    for (;;) {
      const left = node(candidate.left);
      let initialized: Flow;
      if (left?.type === 'VariableDeclaration') {
        const declaration = childNodes(left.declarations)[0];
        const targetScope = left.kind === 'var' ? loopScope.functionScope : loopScope;
        declarePattern(declaration?.id, targetScope);
        const pattern = declaration?.id;
        const bound = pattern
          ? evalPattern(pattern, U, loopCtx, header, targetScope)
          : { normal: { state: header, value: U } };
        initialized = emptyFlow(bound.normal?.state);
        initialized.throws = bound.throws;
      } else if (left) {
        const bound = evalPattern(left, U, loopCtx, header);
        initialized = emptyFlow(bound.normal?.state);
        initialized.throws = bound.throws;
      } else initialized = emptyFlow(header);
      addAbrupt(result, initialized);
      if (!initialized.normal) break;
      const body = node(candidate.body);
      const bodyFlow = body
        ? execStmt(body, loopCtx, initialized.normal, labels)
        : emptyFlow(initialized.normal);
      const consumed = consumeLoopCompletions(bodyFlow, labels);
      addAbrupt(result, consumed.rest);
      result.normal = joinState(result.normal, consumed.exit);
      const nextHeader = joinState(base, consumed.backedge) as State;
      if (equalState(nextHeader, header)) break;
      header = nextHeader;
    }
    return result;
  };

  const execSwitch = (candidate: AstNode, ctx: EvalCtx, entry: State): Flow => {
    const discriminant = node(candidate.discriminant);
    const evaluated = discriminant
      ? evalExpr(discriminant, ctx, entry)
      : { normal: { state: entry, value: U } };
    const result = emptyFlow();
    result.throws = evaluated.throws;
    if (!evaluated.normal) return result;
    const switchScope = makeScope(candidate, ctx.scope);
    const switchCtx = { scope: switchScope };
    const cases = childNodes(candidate.cases);
    predeclareImmediate(
      cases.flatMap((caseNode) => childNodes(caseNode.consequent)),
      switchScope,
    );
    const direct: Array<State | undefined> = new Array(cases.length);
    let unmatched: State | undefined = evaluated.normal.state;
    let defaultIndex = -1;
    for (const [index, caseNode] of cases.entries()) {
      const test = node(caseNode.test);
      if (!test) {
        defaultIndex = index;
        continue;
      }
      if (!unmatched) break;
      const tested = evalExpr(test, switchCtx, unmatched);
      result.throws = joinState(result.throws, tested.throws);
      direct[index] = tested.normal?.state;
      unmatched = tested.normal?.state;
    }
    if (defaultIndex >= 0) direct[defaultIndex] = unmatched;
    else result.normal = joinState(result.normal, unmatched);
    let fallthrough: State | undefined;
    for (const [index, caseNode] of cases.entries()) {
      const input = joinState(direct[index], fallthrough);
      if (!input) continue;
      const flow = execList(caseNode.consequent, switchCtx, input);
      fallthrough = flow.normal;
      result.normal = joinState(result.normal, flow.breaks.get(null));
      const breaks = new Map(flow.breaks);
      breaks.delete(null);
      addAbrupt(result, { ...flow, normal: undefined, breaks });
    }
    result.normal = joinState(result.normal, fallthrough);
    return result;
  };

  const completionEntries = (flow: Flow): Array<[string, string | null, State]> => {
    const entries: Array<[string, string | null, State]> = [];
    if (flow.normal) entries.push(['normal', null, flow.normal]);
    if (flow.returns) entries.push(['returns', null, flow.returns]);
    if (flow.throws) entries.push(['throws', null, flow.throws]);
    for (const [label, state] of flow.breaks) entries.push(['breaks', label, state]);
    for (const [label, state] of flow.continues) entries.push(['continues', label, state]);
    return entries;
  };

  const applyFinally = (incoming: Flow, finalizer: AstNode, ctx: EvalCtx): Flow => {
    const result = emptyFlow();
    for (const [kind, label, state] of completionEntries(incoming)) {
      const finalFlow = execStmt(finalizer, ctx, state);
      if (finalFlow.normal) {
        if (kind === 'normal') result.normal = joinState(result.normal, finalFlow.normal);
        else if (kind === 'returns') result.returns = joinState(result.returns, finalFlow.normal);
        else if (kind === 'throws') result.throws = joinState(result.throws, finalFlow.normal);
        else if (kind === 'breaks')
          result.breaks.set(label, joinState(result.breaks.get(label), finalFlow.normal) as State);
        else
          result.continues.set(
            label,
            joinState(result.continues.get(label), finalFlow.normal) as State,
          );
      }
      addAbrupt(result, { ...finalFlow, normal: undefined });
    }
    return result;
  };

  const execTry = (candidate: AstNode, ctx: EvalCtx, entry: State): Flow => {
    const block = node(candidate.block);
    const tried = block ? execStmt(block, ctx, entry) : emptyFlow(entry);
    let combined = tried;
    const handler = node(candidate.handler);
    if (handler) {
      const catchEntry = tried.throws;
      const surviving = { ...tried, throws: undefined };
      if (catchEntry) {
        const catchScope = makeScope(handler, ctx.scope);
        declarePattern(handler.param, catchScope);
        const initialized = evalPattern(
          handler.param,
          U,
          { scope: catchScope },
          catchEntry,
          catchScope,
        );
        const body = node(handler.body);
        const caught =
          initialized.normal && body
            ? execStmt(body, { scope: catchScope }, initialized.normal.state)
            : emptyFlow(initialized.normal?.state);
        caught.throws = joinState(caught.throws, initialized.throws);
        combined = joinFlow(surviving, caught);
      } else combined = surviving;
    }
    const finalizer = node(candidate.finalizer);
    return finalizer ? applyFinally(combined, finalizer, ctx) : combined;
  };

  const evalClass = (candidate: AstNode, ctx: EvalCtx, state: State): EvalResult => {
    const classScope = makeScope(candidate, ctx.scope);
    for (const parameter of childNodes(node(candidate.typeParameters)?.params)) {
      const name = typeParameterName(parameter);
      if (name) classScope.shadowedTypes.add(name);
    }
    const ownName = identifierName(candidate.id);
    if (ownName) ensureBinding(ownName, classScope, candidate);
    let result = evalList(candidate.decorators, ctx, state);
    const superClass = node(candidate.superClass);
    if (superClass) result = sequenceEval(result, (next) => evalExpr(superClass, ctx, next));
    const body = node(candidate.body);
    for (const element of childNodes(body?.body)) {
      result = sequenceEval(result, (next) => {
        let current: EvalResult = { normal: { state: next, value: U } };
        if (element.computed) {
          const key = node(element.key);
          if (key) current = evalExpr(key, ctx, next);
        }
        for (const decorator of childNodes(element.decorators))
          current = sequenceEval(current, (after) => evalExpr(decorator, ctx, after));
        const value = node(element.value);
        if (value)
          current = sequenceEval(current, (after) => evalExpr(value, { scope: classScope }, after));
        if (['ClassMethod', 'ClassPrivateMethod'].includes(element.type) && current.normal)
          visitFunction(element, classScope, current.normal.state, false);
        if (element.type === 'StaticBlock' && current.normal)
          execStmt(element, { scope: classScope }, current.normal.state);
        return current;
      });
    }
    return result.normal
      ? { normal: { state: result.normal.state, value: U }, throws: result.throws }
      : result;
  };

  const functionParents = new WeakMap<AstNode, Scope>();
  const functionBindingsScope = (candidate: AstNode): Scope =>
    functionParents.get(candidate) ?? root;

  function invokeDirectFunction(
    candidate: AstNode,
    parent: Scope,
    captured: State,
    arguments_: InvocationArgument[],
  ): EvalResult {
    functionParents.set(candidate, parent);
    const scope = makeScope(candidate, parent, true);
    for (const parameter of childNodes(node(candidate.typeParameters)?.params)) {
      const name = typeParameterName(parameter);
      if (name) scope.shadowedTypes.add(name);
    }
    const ownName = identifierName(candidate.id);
    if (ownName) ensureBinding(ownName, scope, candidate);
    const parameters = childNodes(candidate.params);
    for (const parameter of parameters) declarePattern(parameter, scope);
    predeclareVars(candidate.body, scope);
    let initialized: EvalResult = { normal: { state: captured, value: U } };
    for (const [index, parameter] of parameters.entries()) {
      initialized = sequenceEval(initialized, (next) => {
        const argument = arguments_[index] ?? {
          value: U,
          supplied: false,
          undefinedness: 'definite' as const,
        };
        if (parameter.type === 'AssignmentPattern') {
          const explicit =
            argument.supplied && argument.undefinedness !== 'definite'
              ? evalPattern(parameter.left, argument.value, { scope }, next, scope)
              : undefined;
          if (argument.undefinedness === 'no') return explicit as EvalResult;
          const fallback = node(parameter.right);
          const evaluated = fallback
            ? evalExpr(fallback, { scope }, next)
            : { normal: { state: next, value: U } };
          const defaulted = sequenceEval(evaluated, (afterDefault) =>
            evalPattern(
              parameter.left,
              evaluated.normal?.value ?? U,
              { scope },
              afterDefault,
              scope,
            ),
          );
          if (!explicit) return defaulted;
          return {
            normal: explicit.normal &&
              defaulted.normal && {
                state: joinState(explicit.normal.state, defaulted.normal.state) as State,
                value: trustJoin(explicit.normal.value, defaulted.normal.value),
              },
            throws: joinState(explicit.throws, defaulted.throws),
          };
        }
        return evalPattern(parameter, argument.value, { scope }, next, scope);
      });
    }
    if (!initialized.normal) return initialized;
    const body = node(candidate.body);
    if (!body) return initialized;
    if (body.type !== 'BlockStatement') {
      const evaluated = evalExpr(body, { scope }, initialized.normal.state);
      return { normal: evaluated.normal, throws: joinState(initialized.throws, evaluated.throws) };
    }
    const flow = execBlock(body, scope, initialized.normal.state);
    const normal = joinState(flow.normal, flow.returns);
    return {
      normal: normal && { state: normal, value: U },
      throws: joinState(initialized.throws, flow.throws),
    };
  }

  const visitFunction = (
    candidate: AstNode,
    parent: Scope,
    captured: State,
    transactionCallback: boolean,
  ): void => {
    functionParents.set(candidate, parent);
    const prior = analyzedFunctions.get(candidate);
    const widened = joinState(prior, captured) as State;
    if (prior && equalState(prior, widened)) return;
    analyzedFunctions.set(candidate, widened);
    const scope = makeScope(candidate, parent, true);
    for (const parameter of childNodes(node(candidate.typeParameters)?.params)) {
      const name = typeParameterName(parameter);
      if (name) scope.shadowedTypes.add(name);
    }
    const ownName = identifierName(candidate.id);
    if (ownName) ensureBinding(ownName, scope, candidate);
    const parameters = childNodes(candidate.params);
    for (const parameter of parameters) declarePattern(parameter, scope);
    predeclareVars(candidate.body, scope);
    let state = widened;
    for (const [index, parameter] of parameters.entries()) {
      const normalized = unwrapPattern(parameter);
      const annotation = normalized?.typeAnnotation ?? parameter.typeAnnotation;
      const value = (transactionCallback && index === 0) || trustedType(annotation, scope) ? T : U;
      const initialized = evalPattern(parameter, value, { scope }, state, scope);
      if (!initialized.normal) return;
      state = initialized.normal.state;
    }
    const body = node(candidate.body);
    if (body?.type === 'BlockStatement') execBlock(body, scope, state);
    else if (body) evalExpr(body, { scope }, state);
  };

  const execBlock = (candidate: AstNode, parent: Scope, entry: State): Flow => {
    const scope = makeScope(candidate, parent);
    predeclareImmediate(candidate.body, scope);
    for (const statement of childNodes(candidate.body)) {
      if (statement.type !== 'FunctionDeclaration') continue;
      const name = identifierName(statement.id);
      const binding = name ? resolveBinding(name, scope) : undefined;
      if (binding) functionBindings.set(binding, statement);
      functionParents.set(statement, scope);
    }
    return execList(candidate.body, { scope }, entry);
  };

  const execVariableDeclaration = (candidate: AstNode, ctx: EvalCtx, state: State): Flow => {
    let result: EvalResult = { normal: { state, value: U } };
    for (const declaration of childNodes(candidate.declarations)) {
      result = sequenceEval(result, (next) => {
        const targetScope = candidate.kind === 'var' ? ctx.scope.functionScope : ctx.scope;
        declarePattern(declaration.id, targetScope);
        const init = node(declaration.init);
        if (!init && candidate.kind === 'var') return { normal: { state: next, value: U } };
        const simpleName = identifierName(declaration.id);
        if (candidate.kind === 'const' && simpleName) {
          const binding = resolveBinding(simpleName, targetScope);
          const text = staticStringValue(init, ctx.scope);
          if (binding && text !== undefined) staticStrings.set(binding, text);
        }
        const functionValue = unwrapExpression(init);
        if (
          simpleName &&
          functionValue &&
          ['FunctionExpression', 'ArrowFunctionExpression'].includes(functionValue.type)
        ) {
          const binding = resolveBinding(simpleName, targetScope);
          if (binding) functionBindings.set(binding, functionValue);
          functionParents.set(functionValue, ctx.scope);
          deferFunction(functionValue, ctx.scope, next);
        }
        const evaluated = init ? evalExpr(init, ctx, next) : { normal: { state: next, value: U } };
        if (!evaluated.normal) return evaluated;
        const id = node(declaration.id);
        const annotated = trustedType(id?.typeAnnotation, ctx.scope);
        const value = annotated ? T : evaluated.normal.value;
        const bound = evalPattern(declaration.id, value, ctx, evaluated.normal.state, targetScope);
        return { normal: bound.normal, throws: joinState(evaluated.throws, bound.throws) };
      });
    }
    const flow = emptyFlow(result.normal?.state);
    flow.throws = result.throws;
    return flow;
  };

  const execStmt = (
    candidate: AstNode,
    ctx: EvalCtx,
    state: State,
    attachedLabels: LoopLabels = [],
  ): Flow => {
    switch (candidate.type) {
      case 'Program':
        predeclareImmediate(candidate.body, ctx.scope);
        predeclareVars(candidate.body, ctx.scope);
        for (const statement of childNodes(candidate.body)) {
          if (statement.type !== 'FunctionDeclaration') continue;
          const name = identifierName(statement.id);
          const binding = name ? resolveBinding(name, ctx.scope) : undefined;
          if (binding) functionBindings.set(binding, statement);
          functionParents.set(statement, ctx.scope);
        }
        for (const statement of childNodes(candidate.body)) {
          if (statement.type === 'ImportDeclaration')
            initialState = establishImport(statement, ctx.scope, initialState);
        }
        return execList(candidate.body, ctx, initialState);
      case 'ImportDeclaration':
      case 'TSTypeAliasDeclaration':
      case 'TSInterfaceDeclaration':
      case 'DeclareFunction':
      case 'TSDeclareFunction':
      case 'EmptyStatement':
      case 'DebuggerStatement':
        return emptyFlow(state);
      case 'BlockStatement':
      case 'StaticBlock':
      case 'TSModuleBlock':
        return execBlock(candidate, ctx.scope, state);
      case 'ExpressionStatement':
      case 'TSExportAssignment': {
        const expression = node(candidate.expression);
        const evaluated = expression
          ? evalExpr(expression, ctx, state)
          : { normal: { state, value: U } };
        const flow = emptyFlow(evaluated.normal?.state);
        flow.throws = evaluated.throws;
        return flow;
      }
      case 'VariableDeclaration':
        return execVariableDeclaration(candidate, ctx, state);
      case 'FunctionDeclaration': {
        const name = identifierName(candidate.id);
        const binding = name ? resolveBinding(name, ctx.scope) : undefined;
        if (binding) functionBindings.set(binding, candidate);
        functionParents.set(candidate, ctx.scope);
        deferFunction(candidate, ctx.scope, state);
        return emptyFlow(state);
      }
      case 'ClassDeclaration': {
        const evaluated = evalClass(candidate, ctx, state);
        const flow = emptyFlow(evaluated.normal?.state);
        flow.throws = evaluated.throws;
        return flow;
      }
      case 'IfStatement': {
        const test = node(candidate.test);
        const tested = test ? evalExpr(test, ctx, state) : { normal: { state, value: U } };
        if (!tested.normal) {
          const flow = emptyFlow();
          flow.throws = tested.throws;
          return flow;
        }
        const consequent = node(candidate.consequent);
        const alternate = node(candidate.alternate);
        const yes = consequent
          ? execStmt(consequent, ctx, tested.normal.state)
          : emptyFlow(tested.normal.state);
        const no = alternate
          ? execStmt(alternate, ctx, tested.normal.state)
          : emptyFlow(tested.normal.state);
        const joined = joinFlow(yes, no);
        joined.throws = joinState(tested.throws, joined.throws);
        return joined;
      }
      case 'ReturnStatement':
      case 'ThrowStatement': {
        const argument = node(candidate.argument);
        const evaluated = argument
          ? evalExpr(argument, ctx, state)
          : { normal: { state, value: U } };
        const flow = emptyFlow();
        flow.throws = evaluated.throws;
        if (evaluated.normal) {
          if (candidate.type === 'ReturnStatement') flow.returns = evaluated.normal.state;
          else flow.throws = joinState(flow.throws, evaluated.normal.state);
        }
        return flow;
      }
      case 'BreakStatement': {
        const flow = emptyFlow();
        flow.breaks.set(identifierName(candidate.label) ?? null, state);
        return flow;
      }
      case 'ContinueStatement': {
        const flow = emptyFlow();
        flow.continues.set(identifierName(candidate.label) ?? null, state);
        return flow;
      }
      case 'LabeledStatement': {
        const label = identifierName(candidate.label) ?? null;
        const body = node(candidate.body);
        if (!body) return emptyFlow(state);
        const loopTypes = new Set([
          'WhileStatement',
          'DoWhileStatement',
          'ForStatement',
          'ForInStatement',
          'ForOfStatement',
        ]);
        let target = body;
        while (target.type === 'LabeledStatement') target = node(target.body) ?? target;
        const targetsLoop = loopTypes.has(target.type);
        const labels = label ? [...attachedLabels, label] : attachedLabels;
        const flow = execStmt(body, ctx, state, targetsLoop ? labels : attachedLabels);
        if (label && !targetsLoop) {
          flow.normal = joinState(flow.normal, flow.breaks.get(label));
          flow.breaks.delete(label);
        }
        return flow;
      }
      case 'WhileStatement':
        return execWhile(candidate, ctx, state, attachedLabels, false);
      case 'DoWhileStatement': {
        const body = node(candidate.body);
        if (!body) return emptyFlow(state);
        const first = execStmt(body, ctx, state, attachedLabels);
        const consumed = consumeLoopCompletions(first, attachedLabels);
        const rest = consumed.rest;
        rest.normal = consumed.exit;
        if (consumed.backedge) {
          const later = execWhile(candidate, ctx, consumed.backedge, attachedLabels, true);
          return joinFlow(rest, later);
        }
        return rest;
      }
      case 'ForStatement':
        return execFor(candidate, ctx, state, attachedLabels);
      case 'ForInStatement':
      case 'ForOfStatement':
        return execForEach(candidate, ctx, state, attachedLabels);
      case 'SwitchStatement':
        return execSwitch(candidate, ctx, state);
      case 'TryStatement':
        return execTry(candidate, ctx, state);
      case 'WithStatement': {
        const object = node(candidate.object);
        const evaluated = object ? evalExpr(object, ctx, state) : { normal: { state, value: U } };
        const body = node(candidate.body);
        const flow =
          evaluated.normal && body ? execStmt(body, ctx, evaluated.normal.state) : emptyFlow();
        flow.throws = joinState(flow.throws, evaluated.throws, evaluated.normal?.state);
        return flow;
      }
      case 'ExportNamedDeclaration':
      case 'ExportDefaultDeclaration': {
        const declaration = node(candidate.declaration);
        if (!declaration) return emptyFlow(state);
        if (declaration.type === 'Identifier') {
          const evaluated = evalExpr(declaration, ctx, state);
          return emptyFlow(evaluated.normal?.state);
        }
        return execStmt(declaration, ctx, state);
      }
      case 'ExportAllDeclaration':
        return emptyFlow(state);
      case 'TSModuleDeclaration': {
        const body = node(candidate.body);
        return body
          ? execStmt(body, { scope: makeScope(candidate, ctx.scope) }, state)
          : emptyFlow(state);
      }
      default:
        return failExecutable(candidate, 'statement');
    }
  };

  function failExecutable(candidate: AstNode, position: string): never {
    throw new Error(
      `audit:hub-sync-writers: unsupported executable ${position} node ${candidate.type} in ${file}`,
    );
  }

  execStmt(program, { scope: root }, initialState);
  for (let index = 0; index < pendingFunctions.length; index += 1) {
    const pending = pendingFunctions[index];
    if (!pending || analyzedFunctions.has(pending.candidate)) continue;
    visitFunction(pending.candidate, pending.parent, pending.state, false);
  }
  return [...writes.values()].sort((left, right) => left.index - right.index);
}
