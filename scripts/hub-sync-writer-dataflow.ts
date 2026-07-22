import { parse } from '@babel/parser';

type AstNode = {
  type: string;
  start?: number | null;
  [key: string]: unknown;
};

// Trust is a bitset: U=unknown, T=trusted DB, N=trusted DB namespace, D=undefined.
type Trust = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10 | 11 | 12 | 13 | 14 | 15;
const U: Trust = 1;
const T: Trust = 2;
const N: Trust = 4;
const D: Trust = 8;

type Binding = { id: number; name: string; scope: Scope; decl: AstNode };
type AliasParameter = { name: string; defaultType?: AstNode };
type TypeAlias = {
  id: number;
  bodies: AstNode[];
  extendsTypes: AstNode[];
  parameters: AliasParameter[];
  scope: Scope;
  interface: boolean;
};
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
type PositionalValue = {
  value: Trust;
  elements?: readonly Trust[];
  elementValues?: readonly PositionalValue[];
  elementsExact?: boolean;
};
type EvalResult = {
  normal?: PositionalValue & { state: State };
  throws?: State;
};
type InvocationArgument = {
  value: Trust;
  elements?: readonly Trust[];
  supplied: boolean;
  undefinedness: 'definite' | 'maybe' | 'no';
};
type EvalCtx = { scope: Scope };
type DrizzleWrite = { index: number; end: number; table: string };
type InternalApplyMarker = { index: number; end: number };
export type DrizzleAuditResult = {
  writes: DrizzleWrite[];
  internalApplyMarkers: InternalApplyMarker[];
};

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
      'TSTypeAssertion',
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

export function collectDrizzleWrites(source: string, file: string): DrizzleAuditResult {
  let program: AstNode;
  try {
    program = parse(source, {
      sourceType: 'module',
      plugins: file.endsWith('.tsx') ? ['typescript', 'jsx'] : ['typescript'],
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
  const internalApplyMarkers = new Map<number, InternalApplyMarker>();
  const scopeCache = new WeakMap<AstNode, Scope>();
  const analyzedFunctions = new WeakMap<AstNode, State>();
  const transactionAnalyzedFunctions = new WeakSet<AstNode>();
  const functionBindings = new Map<Binding, AstNode>();
  const objectFunctions = new Map<Binding, Map<string, AstNode>>();
  const escapedFunctions = new Set<AstNode>();
  const staticStrings = new Map<Binding, string>();
  const staticSqlTexts = new Map<Binding, string>();
  const staticStringWriteKeys = new Map<Binding, Set<string>>();
  const staticStringMarkerIndexes = new Map<Binding, Set<number>>();
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

  const resolveCallable = (value: unknown, scope: Scope): AstNode | undefined => {
    const candidate = unwrapExpression(value);
    if (!candidate) return undefined;
    if (['FunctionExpression', 'ArrowFunctionExpression'].includes(candidate.type))
      return candidate;
    if (candidate.type === 'Identifier') {
      const binding = resolveBinding(candidate.name as string, scope);
      return binding ? functionBindings.get(binding) : undefined;
    }
    if (candidate.type === 'MemberExpression' && !candidate.computed) {
      const objectName = identifierName(candidate.object);
      const propertyName = identifierName(candidate.property);
      const binding = objectName ? resolveBinding(objectName, scope) : undefined;
      return binding && propertyName ? objectFunctions.get(binding)?.get(propertyName) : undefined;
    }
    return undefined;
  };

  const escapeValue = (value: unknown, scope: Scope): void => {
    const callable = resolveCallable(value, scope);
    if (callable) escapedFunctions.add(callable);
    const candidate = unwrapExpression(value);
    if (candidate?.type !== 'Identifier') return;
    const binding = resolveBinding(candidate.name as string, scope);
    for (const propertyFunction of binding ? (objectFunctions.get(binding)?.values() ?? []) : [])
      escapedFunctions.add(propertyFunction);
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
        statement.type === 'ClassDeclaration' ||
        statement.type === 'TSEnumDeclaration' ||
        statement.type === 'TSImportEqualsDeclaration'
      ) {
        const name = identifierName(statement.id);
        if (name) ensureBinding(name, scope, statement);
      } else if (
        statement.type === 'TSTypeAliasDeclaration' ||
        statement.type === 'TSInterfaceDeclaration'
      ) {
        const name = identifierName(statement.id);
        const body =
          statement.type === 'TSInterfaceDeclaration'
            ? ({
                type: 'TSTypeLiteral',
                members: statement.body && node(statement.body)?.body,
              } as AstNode)
            : node(statement.typeAnnotation);
        if (!name || !body) continue;
        const parameters = childNodes(node(statement.typeParameters)?.params)
          .map((parameter) => {
            const parameterName = typeParameterName(parameter);
            if (!parameterName) return undefined;
            const defaultType = node(parameter.default);
            return defaultType ? { name: parameterName, defaultType } : { name: parameterName };
          })
          .filter((parameter): parameter is AliasParameter => parameter !== undefined);
        const existing = scope.types.get(name);
        if (existing) {
          if (
            existing.interface &&
            statement.type === 'TSInterfaceDeclaration' &&
            existing.parameters.map((parameter) => parameter.name).join() ===
              parameters.map((parameter) => parameter.name).join()
          ) {
            existing.bodies.push(body);
            existing.extendsTypes.push(...childNodes(statement.extends));
          }
          continue;
        }
        scope.types.set(name, {
          id: nextAliasId++,
          bodies: [body],
          extendsTypes: childNodes(statement.extends),
          parameters,
          scope,
          interface: statement.type === 'TSInterfaceDeclaration',
        });
      }
    }
  };

  const predeclareVars = (value: unknown, functionScope: Scope, state: State): State => {
    let initialized = state;
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
        for (const declaration of childNodes(candidate.declarations)) {
          const existingBindings = new Set(functionScope.bindings.values());
          declarePattern(declaration.id, functionScope);
          for (const binding of functionScope.bindings.values()) {
            if (!existingBindings.has(binding)) initialized = store(binding, D, initialized);
          }
        }
      }
      for (const [key, child] of Object.entries(candidate)) {
        if (key === 'loc' || key === 'start' || key === 'end') continue;
        initialized = predeclareVars(child, functionScope, initialized);
      }
    }
    return initialized;
  };

  type Substitution = { type: AstNode | undefined; scope: Scope };
  type Substitutions = Map<string, Substitution>;
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
    if (candidate.type === 'TSImportType') {
      const argument = node(candidate.argument);
      const source =
        argument?.type === 'StringLiteral' && typeof argument.value === 'string'
          ? argument.value
          : undefined;
      const qualifier = node(candidate.qualifier);
      const terminal = identifierName(qualifier);
      return Boolean(
        source && isRepoDbModule(source, file) && terminal && DB_TYPE_EXPORTS.has(terminal),
      );
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
      return replacement?.type
        ? trustedType(replacement.type, replacement.scope, substitutions, seen)
        : false;
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
        const replacementName = identifierName(node(actual)?.typeName);
        local.set(
          parameter.name,
          (replacementName && substitutions.get(replacementName)) || { type: actual, scope },
        );
        actualKey.push(actual ? `${actual.type}:${actual.start ?? ''}` : '?');
      }
      const key = `${alias.id}<${actualKey.join(',')}>`;
      if (seen.has(key)) return false;
      const nextSeen = new Set(seen);
      nextSeen.add(key);
      return alias.bodies.every((body) => trustedType(body, alias.scope, local, nextSeen));
    }
    return false;
  };

  type TypeView = {
    type: AstNode;
    scope: Scope;
    substitutions: Substitutions;
    seen: Set<string>;
  };

  const interfaceInheritanceCycle = (alias: TypeAlias, path = new Set<number>()): boolean => {
    if (path.has(alias.id)) return true;
    const nextPath = new Set(path);
    nextPath.add(alias.id);
    return alias.extendsTypes.some((base) => {
      const candidate = node(base);
      const name = identifierName(
        candidate?.type === 'TSExpressionWithTypeArguments'
          ? candidate.expression
          : node(candidate?.typeName),
      );
      if (!name) return false;
      for (let current: Scope | undefined = alias.scope; current; current = current.parent) {
        if (current.shadowedTypes.has(name)) return false;
        const inherited = current.types.get(name);
        if (inherited) return interfaceInheritanceCycle(inherited, nextPath);
      }
      return false;
    });
  };

  const propertyTypeViews = (
    typeValue: unknown,
    propertyName: string,
    scope: Scope,
    substitutions: Substitutions = new Map(),
    seen = new Set<string>(),
  ): TypeView[] => {
    const candidate = node(typeValue);
    if (!candidate) return [];
    if (candidate.type === 'TSTypeAnnotation')
      return propertyTypeViews(candidate.typeAnnotation, propertyName, scope, substitutions, seen);
    if (candidate.type === 'TSParenthesizedType' || candidate.type === 'TSOptionalType')
      return propertyTypeViews(candidate.typeAnnotation, propertyName, scope, substitutions, seen);
    if (candidate.type === 'TSUnionType') {
      const parts = childNodes(candidate.types).filter(
        (part) => !['TSNullKeyword', 'TSUndefinedKeyword', 'TSNeverKeyword'].includes(part.type),
      );
      const resolved = parts.map((part) =>
        propertyTypeViews(part, propertyName, scope, substitutions, new Set(seen)),
      );
      return resolved.every((views) => views.length > 0) ? resolved.flat() : [];
    }
    if (candidate.type === 'TSIntersectionType') {
      return childNodes(candidate.types).flatMap((part) =>
        propertyTypeViews(part, propertyName, scope, substitutions, new Set(seen)),
      );
    }
    if (candidate.type === 'TSTypeLiteral') {
      for (const member of childNodes(candidate.members)) {
        if (member.type !== 'TSPropertySignature') continue;
        const name = member.computed
          ? staticComputedPropertyName(member.key)
          : identifierName(member.key);
        const annotation = node(member.typeAnnotation);
        if (name === propertyName && annotation)
          return [{ type: annotation, scope, substitutions, seen }];
      }
      return [];
    }
    if (candidate.type === 'TSExpressionWithTypeArguments') {
      const expression = node(candidate.expression);
      return expression
        ? propertyTypeViews(
            {
              type: 'TSTypeReference',
              typeName: expression,
              typeParameters: candidate.typeParameters,
            },
            propertyName,
            scope,
            substitutions,
            seen,
          )
        : [];
    }
    if (candidate.type !== 'TSTypeReference') return [];
    const name = identifierName(candidate.typeName);
    if (!name) return [];
    if (substitutions.has(name)) {
      const replacement = substitutions.get(name);
      return replacement?.type
        ? propertyTypeViews(replacement.type, propertyName, replacement.scope, substitutions, seen)
        : [];
    }
    for (let current: Scope | undefined = scope; current; current = current.parent) {
      if (current.shadowedTypes.has(name)) return [];
      const alias = current.types.get(name);
      if (!alias) continue;
      if (interfaceInheritanceCycle(alias)) return [];
      const arguments_ = childNodes(node(candidate.typeParameters)?.params);
      const local = new Map(substitutions);
      const actualKey: string[] = [];
      for (const [index, parameter] of alias.parameters.entries()) {
        const actual = arguments_[index] ?? parameter.defaultType;
        const replacementName = identifierName(node(actual)?.typeName);
        local.set(
          parameter.name,
          (replacementName && substitutions.get(replacementName)) || { type: actual, scope },
        );
        actualKey.push(actual ? `${actual.type}:${actual.start ?? ''}` : '?');
      }
      const key = `${alias.id}<${actualKey.join(',')}>`;
      if (seen.has(key)) return [];
      const nextSeen = new Set(seen);
      nextSeen.add(key);
      const ownViews = alias.bodies.flatMap((body) =>
        propertyTypeViews(body, propertyName, alias.scope, local, new Set(nextSeen)),
      );
      const inheritedViews = alias.extendsTypes.flatMap((base) =>
        propertyTypeViews(base, propertyName, alias.scope, local, new Set(nextSeen)),
      );
      return [...ownViews, ...inheritedViews];
    }
    return [];
  };

  const trustedPatternBindings = (
    pattern: unknown,
    typeValue: unknown,
    scope: Scope,
  ): Set<AstNode> => {
    const trusted = new Set<AstNode>();
    const visit = (value: unknown, views: TypeView[]): void => {
      const candidate = node(value);
      if (!candidate) return;
      if (candidate.type === 'TSParameterProperty') {
        visit(candidate.parameter, views);
        return;
      }
      if (candidate.type === 'RestElement') return;
      if (candidate.type === 'AssignmentPattern') {
        visit(candidate.left, views);
        return;
      }
      if (candidate.type === 'Identifier') {
        if (
          views.length > 0 &&
          views.every((view) =>
            trustedType(view.type, view.scope, view.substitutions, new Set(view.seen)),
          )
        )
          trusted.add(candidate);
        return;
      }
      if (candidate.type !== 'ObjectPattern') return;
      for (const property of childNodes(candidate.properties)) {
        if (property.type === 'RestElement') continue;
        const propertyName = property.computed
          ? staticComputedPropertyName(property.key)
          : identifierName(property.key);
        if (!propertyName) continue;
        const propertyViews = views.flatMap((view) =>
          propertyTypeViews(
            view.type,
            propertyName,
            view.scope,
            view.substitutions,
            new Set(view.seen),
          ),
        );
        if (propertyViews.length > 0) visit(property.value, propertyViews);
      }
    };
    const annotation = node(typeValue);
    if (annotation)
      visit(pattern, [{ type: annotation, scope, substitutions: new Map(), seen: new Set() }]);
    return trusted;
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
        next = store(binding, N, next);
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
      const templateElement = childNodes(candidate.quasis)[0];
      const templateValue = templateElement?.value;
      const cooked =
        templateValue && typeof templateValue === 'object'
          ? (templateValue as { cooked?: unknown }).cooked
          : undefined;
      return typeof cooked === 'string' ? cooked : undefined;
    }
    if (candidate.type === 'Identifier') {
      const binding = resolveBinding(candidate.name as string, scope);
      return binding ? staticStrings.get(binding) : undefined;
    }
    return undefined;
  };

  const staticSqlTextValue = (value: unknown, scope: Scope): string | undefined => {
    const candidate = unwrapExpression(value);
    if (!candidate) return undefined;
    if (candidate.type === 'Identifier') {
      const binding = resolveBinding(candidate.name as string, scope);
      return binding ? staticSqlTexts.get(binding) : undefined;
    }
    if (candidate.type !== 'CallExpression') return undefined;
    const callee = unwrapExpression(candidate.callee);
    if (
      callee?.type !== 'MemberExpression' ||
      callee.computed ||
      identifierName(callee.object) !== 'sql' ||
      identifierName(callee.property) !== 'raw'
    )
      return undefined;
    return staticStringValue(childNodes(candidate.arguments)[0], scope);
  };

  const reportWrite = (candidate: AstNode, receiver: Trust, method: string | undefined): void => {
    if (!(receiver & T) || !method || !WRITE_METHODS.has(method) || candidate.start == null) return;
    const tableName = tableArgumentName(childNodes(candidate.arguments)[0]);
    if (!tableName) return;
    writes.set(`${candidate.start}:${tableName}`, {
      index: candidate.start,
      end: typeof candidate.end === 'number' ? candidate.end : candidate.start,
      table: tableName,
    });
  };

  const invalidateStaticString = (binding: Binding | undefined): void => {
    if (!binding) return;
    staticStrings.delete(binding);
    staticSqlTexts.delete(binding);
    for (const key of staticStringWriteKeys.get(binding) ?? []) writes.delete(key);
    for (const index of staticStringMarkerIndexes.get(binding) ?? [])
      internalApplyMarkers.delete(index);
    staticStringWriteKeys.delete(binding);
    staticStringMarkerIndexes.delete(binding);
  };

  const RAW_SQL_TABLE_PATTERNS = new Map(
    ['hub_sync_reconciliation', 'knowledge', 'knowledge_edge'].map((table) => [
      table,
      new RegExp(`\\b(?:update|insert\\s+into|delete\\s+from)\\s+"?${table}\\b`, 'i'),
    ]),
  );

  const reportRawText = (candidate: AstNode, text: string, staticBinding?: Binding): void => {
    if (candidate.start == null) return;
    if (text.includes('app.hub_sync_internal_apply')) {
      internalApplyMarkers.set(candidate.start, {
        index: candidate.start,
        end: typeof candidate.end === 'number' ? candidate.end : candidate.start,
      });
      if (staticBinding) {
        const indexes = staticStringMarkerIndexes.get(staticBinding) ?? new Set<number>();
        indexes.add(candidate.start);
        staticStringMarkerIndexes.set(staticBinding, indexes);
      }
    }
    for (const [table, pattern] of RAW_SQL_TABLE_PATTERNS) {
      if (!pattern.test(text)) continue;
      const key = `${candidate.start}:${table}`;
      writes.set(key, {
        index: candidate.start,
        end: typeof candidate.end === 'number' ? candidate.end : candidate.start,
        table,
      });
      if (staticBinding) {
        const keys = staticStringWriteKeys.get(staticBinding) ?? new Set<string>();
        keys.add(key);
        staticStringWriteKeys.set(staticBinding, keys);
      }
    }
  };

  const reportRawExecute = (
    candidate: AstNode,
    receiver: Trust,
    method: string | undefined,
    scope: Scope,
  ): void => {
    if (!(receiver & T) || method !== 'execute' || candidate.start == null) return;
    const executeArgument = unwrapExpression(childNodes(candidate.arguments)[0]);
    const storedSqlBinding =
      executeArgument?.type === 'Identifier'
        ? resolveBinding(executeArgument.name as string, scope)
        : undefined;
    const storedSqlText = storedSqlBinding ? staticSqlTexts.get(storedSqlBinding) : undefined;
    if (storedSqlText) {
      reportRawText(candidate, storedSqlText, storedSqlBinding);
      return;
    }
    if (executeArgument?.type === 'TaggedTemplateExpression') {
      const tag = unwrapExpression(executeArgument.tag);
      if (identifierName(tag) !== 'sql') return;
      const quasi = node(executeArgument.quasi);
      const quasis = childNodes(quasi?.quasis);
      const text = quasis
        .map((part) => {
          const value = part.value;
          return value && typeof value === 'object'
            ? String((value as { cooked?: unknown }).cooked ?? '')
            : '';
        })
        .join(' ');
      reportRawText(candidate, text);
      return;
    }
    const rawCall = executeArgument;
    const rawCallee = rawCall && unwrapExpression(rawCall.callee);
    if (
      rawCall?.type !== 'CallExpression' ||
      rawCallee?.type !== 'MemberExpression' ||
      rawCallee.computed ||
      identifierName(rawCallee.object) !== 'sql' ||
      identifierName(rawCallee.property) !== 'raw'
    )
      return;
    const rawArgument = unwrapExpression(childNodes(rawCall.arguments)[0]);
    const staticBinding =
      rawArgument?.type === 'Identifier'
        ? resolveBinding(rawArgument.name as string, scope)
        : undefined;
    const text = staticStringValue(rawArgument, scope);
    if (!text) return;
    reportRawText(candidate, text, staticBinding);
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
    const propertyName = candidate.computed
      ? staticComputedPropertyName(candidate.property)
      : identifierName(candidate.property);
    const value =
      result.normal.value & N && propertyName === 'db'
        ? T
        : result.normal.value & T && propertyName === 'with'
          ? T
          : U;
    return {
      normal: { state: result.normal.state, value },
      throws: joinState(result.throws, result.normal.state),
    };
  };

  const evalPattern = (
    pattern: unknown,
    value: Trust,
    ctx: EvalCtx,
    state: State,
    declarationScope?: Scope,
    trustedBindings?: Set<AstNode>,
    elements?: readonly Trust[],
  ): EvalResult => {
    const candidate = node(pattern);
    if (!candidate) return { normal: { state, value } };
    if (candidate.type === 'TSParameterProperty')
      return evalPattern(
        candidate.parameter,
        value,
        ctx,
        state,
        declarationScope,
        trustedBindings,
        elements,
      );
    if (candidate.type === 'Identifier') {
      const binding = declarationScope
        ? ensureBinding(candidate.name as string, declarationScope, candidate)
        : resolveBinding(candidate.name as string, ctx.scope);
      if (!declarationScope) invalidateStaticString(binding);
      const storedValue = trustedBindings?.has(candidate) ? T : value;
      return { normal: { state: store(binding, storedValue, state), value: storedValue } };
    }
    if (candidate.type === 'RestElement')
      return evalPattern(candidate.argument, value, ctx, state, declarationScope, trustedBindings);
    if (candidate.type === 'AssignmentPattern') {
      const fallback = node(candidate.right);
      const fallbackResult = fallback ? evalExpr(fallback, ctx, state) : undefined;
      const mergedValue = fallbackResult?.normal
        ? trustJoin(value, fallbackResult.normal.value)
        : value;
      const mergedState = joinState(state, fallbackResult?.normal?.state) as State;
      const stored = evalPattern(
        candidate.left,
        mergedValue,
        ctx,
        mergedState,
        declarationScope,
        trustedBindings,
      );
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
              trustedBindings,
            ),
          );
        });
      }
      return result;
    }
    if (candidate.type === 'ArrayPattern') {
      let result: EvalResult = { normal: { state, value } };
      for (const [index, rawElement] of (Array.isArray(candidate.elements)
        ? candidate.elements
        : []
      ).entries()) {
        const element = node(rawElement);
        if (!element) continue;
        result = sequenceEval(result, (next) =>
          evalPattern(
            element,
            elements?.[index] ?? U,
            ctx,
            next,
            declarationScope,
            trustedBindings,
          ),
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
    let memberFunction: AstNode | undefined;
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
      const objectName = identifierName(member.object);
      const objectBinding = objectName ? resolveBinding(objectName, ctx.scope) : undefined;
      if (objectBinding && method) memberFunction = objectFunctions.get(objectBinding)?.get(method);
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
        const callbackName = identifierName(callback);
        const callbackBinding = callbackName ? resolveBinding(callbackName, ctx.scope) : undefined;
        const callbackFunction = callbackBinding
          ? functionBindings.get(callbackBinding)
          : undefined;
        const transactionCallback = method === 'transaction' && Boolean(receiver & T);
        if (callback && ['ArrowFunctionExpression', 'FunctionExpression'].includes(callback.type)) {
          visitFunction(callback, ctx.scope, next, transactionCallback);
          invocationArguments.push({ value: U, supplied: true, undefinedness: 'no' });
          return { normal: { state: next, value: U } };
        }
        if (callbackFunction && transactionCallback) {
          visitFunction(callbackFunction, functionBindingsScope(callbackFunction), next, true);
        } else if (callbackFunction) {
          escapedFunctions.add(callbackFunction);
        } else if (!transactionCallback) {
          escapeValue(callback, ctx.scope);
        }
        const evaluated = evalExpr(argument, ctx, next);
        if (evaluated.normal) {
          const value = evaluated.normal.value;
          const undefinedness = value === D ? 'definite' : value & D ? 'maybe' : 'no';
          invocationArguments.push({
            value: (value & ~D || U) as Trust,
            elements: evaluated.normal.elements,
            supplied: true,
            undefinedness,
          });
        }
        return evaluated;
      });
      if (!argumentsResult.normal) break;
    }
    if (!argumentsResult.normal) return argumentsResult;
    const after = argumentsResult.normal.state;
    if (memberFunction)
      visitFunction(memberFunction, functionBindingsScope(memberFunction), after, false);
    if (directFunction) {
      const invoked = invokeDirectFunction(directFunction, ctx.scope, after, invocationArguments);
      return {
        normal: invoked.normal && { state: invoked.normal.state, value: U },
        throws: joinState(argumentsResult.throws, invoked.throws),
      };
    }
    return {
      normal: { state: after, value: receiver & T && method === 'with' ? T : U },
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
    const assign = (input: State, value: Trust, elements?: readonly Trust[]): EvalResult => {
      const target = unwrapExpression(left) ?? left;
      if (target.type === 'Identifier') {
        const binding = resolveBinding(target.name as string, ctx.scope);
        invalidateStaticString(binding);
        if (binding) {
          functionBindings.delete(binding);
          objectFunctions.delete(binding);
        }
        return {
          normal: {
            state: store(binding, value, input),
            value,
          },
        };
      }
      if (target.type === 'MemberExpression' && !target.computed) {
        const objectName = identifierName(target.object);
        const propertyName = identifierName(target.property);
        const binding = objectName ? resolveBinding(objectName, ctx.scope) : undefined;
        if (binding && propertyName) objectFunctions.get(binding)?.delete(propertyName);
      }
      if (target.type === 'ObjectPattern' || target.type === 'ArrayPattern')
        return evalPattern(target, value, ctx, input, undefined, undefined, elements);
      return { normal: { state: input, value } };
    };
    if (operator === '=') {
      const target = unwrapExpression(left) ?? left;
      const functionValue = unwrapExpression(right);
      const rhs = evalExpr(right, ctx, reference.normal.state);
      if (!rhs.normal) return { throws: joinState(reference.throws, rhs.throws) };
      const stored = assign(rhs.normal.state, rhs.normal.value, rhs.normal.elements);
      if (target.type === 'Identifier') {
        const binding = resolveBinding(target.name as string, ctx.scope);
        const assignedFunction = resolveCallable(functionValue, ctx.scope);
        if (binding && assignedFunction) functionBindings.set(binding, assignedFunction);
        if (
          binding &&
          functionValue &&
          ['FunctionExpression', 'ArrowFunctionExpression'].includes(functionValue.type)
        ) {
          functionParents.set(functionValue, ctx.scope);
          deferFunction(functionValue, ctx.scope, reference.normal.state);
        }
      }
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
      case 'Identifier': {
        const binding = resolveBinding(candidate.name as string, ctx.scope);
        return {
          normal: {
            state,
            value: !binding && candidate.name === 'undefined' ? D : load(binding, state),
          },
        };
      }
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
            value: trustJoin(U, taken.normal.value),
          },
          throws: taken.throws,
        };
      }
      case 'CallExpression':
      case 'OptionalCallExpression': {
        const callee = unwrapExpression(candidate.callee);
        if (
          callee &&
          ['MemberExpression', 'OptionalMemberExpression'].includes(callee.type) &&
          identifierName(callee.object) === 'Promise' &&
          !resolveBinding('Promise', ctx.scope) &&
          (callee.computed
            ? staticComputedPropertyName(callee.property) === 'all'
            : identifierName(callee.property) === 'all')
        ) {
          let evaluated: EvalResult = { normal: { state, value: U } };
          const argumentValues: PositionalValue[] = [];
          let argumentsExact = true;
          for (const argument of childNodes(candidate.arguments)) {
            evaluated = sequenceEval(evaluated, (next) => {
              const argumentResult = evalExpr(argument, ctx, next);
              if (argumentResult.normal && argumentsExact) {
                if (argument.type !== 'SpreadElement') {
                  argumentValues.push(argumentResult.normal);
                } else if (
                  argumentResult.normal.elementsExact &&
                  argumentResult.normal.elementValues
                ) {
                  argumentValues.push(...argumentResult.normal.elementValues);
                } else {
                  argumentsExact = false;
                }
              }
              return argumentResult;
            });
          }
          if (!evaluated.normal) return evaluated;
          const tupleElements = argumentsExact ? argumentValues[0]?.elements : undefined;
          const completed = {
            state: evaluated.normal.state,
            value: U as Trust,
            elements: tupleElements,
          };
          return {
            normal:
              candidate.optional || callee.optional
                ? {
                    ...completed,
                    state: joinState(state, completed.state) as State,
                  }
                : completed,
            throws: joinState(evaluated.throws, evaluated.normal.state),
          };
        }
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
            ? (() => {
                const binding = resolveBinding(target.name as string, ctx.scope);
                invalidateStaticString(binding);
                return store(binding, U, reference.normal.state);
              })()
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
        const value = candidate.operator === 'void' ? D : U;
        return argument
          ? sequenceEval(evalExpr(argument, ctx, state), (next) => ({
              normal: { state: next, value },
            }))
          : { normal: { state, value } };
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
      case 'ArrayExpression': {
        let result: EvalResult = { normal: { state, value: U } };
        const elements: Trust[] = [];
        const elementValues: PositionalValue[] = [];
        let elementsExact = true;
        for (const rawElement of Array.isArray(candidate.elements) ? candidate.elements : []) {
          const element = node(rawElement);
          if (!element) {
            if (elementsExact) {
              elements.push(U);
              elementValues.push({ value: U });
            }
            continue;
          }
          result = sequenceEval(result, (next) => {
            const evaluated = evalExpr(element, ctx, next);
            if (evaluated.normal && elementsExact) {
              if (element.type !== 'SpreadElement') {
                elements.push(evaluated.normal.value);
                elementValues.push(evaluated.normal);
              } else if (evaluated.normal.elementsExact && evaluated.normal.elementValues) {
                elements.push(...(evaluated.normal.elements ?? []));
                elementValues.push(...evaluated.normal.elementValues);
              } else {
                elementsExact = false;
              }
            }
            return evaluated;
          });
        }
        return result.normal
          ? {
              normal: {
                state: result.normal.state,
                value: U,
                elements,
                elementValues,
                elementsExact,
              },
              throws: result.throws,
            }
          : result;
      }
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
            if (value) {
              const functionValue = unwrapExpression(value);
              if (
                functionValue &&
                ['ArrowFunctionExpression', 'FunctionExpression'].includes(functionValue.type)
              ) {
                functionParents.set(functionValue, ctx.scope);
                deferFunction(functionValue, ctx.scope, current.normal?.state ?? next);
              }
              current = sequenceEval(current, (afterKey) => evalExpr(value, ctx, afterKey));
            }
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

  const execWhile = (candidate: AstNode, ctx: EvalCtx, entry: State, labels: LoopLabels): Flow => {
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
    const trustedParameters = parameters.map((parameter) => {
      const normalized = unwrapPattern(parameter);
      const annotation = normalized?.typeAnnotation ?? parameter.typeAnnotation;
      return {
        annotation,
        bindings: trustedPatternBindings(parameter, annotation, scope),
      };
    });
    const hoisted = predeclareVars(candidate.body, scope, captured);
    let initialized: EvalResult = { normal: { state: hoisted, value: U } };
    for (const [index, parameter] of parameters.entries()) {
      initialized = sequenceEval(initialized, (next) => {
        const argument = arguments_[index] ?? {
          value: U,
          supplied: false,
          undefinedness: 'definite' as const,
        };
        const trusted = trustedParameters[index];
        const argumentValue = trustedType(trusted?.annotation, scope) ? T : argument.value;
        const trustedBindings = trusted?.bindings;
        if (parameter.type === 'AssignmentPattern') {
          const explicit =
            argument.supplied && argument.undefinedness !== 'definite'
              ? evalPattern(
                  parameter.left,
                  argumentValue,
                  { scope },
                  next,
                  scope,
                  trustedBindings,
                  argument.elements,
                )
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
              trustedBindings,
              evaluated.normal?.elements,
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
        return evalPattern(
          parameter,
          argumentValue,
          { scope },
          next,
          scope,
          trustedBindings,
          argument.elements,
        );
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
    const newTransactionAnalysis =
      transactionCallback && !transactionAnalyzedFunctions.has(candidate);
    if (prior && equalState(prior, widened) && !newTransactionAnalysis) return;
    analyzedFunctions.set(candidate, widened);
    if (transactionCallback) transactionAnalyzedFunctions.add(candidate);
    const scope = makeScope(candidate, parent, true);
    for (const parameter of childNodes(node(candidate.typeParameters)?.params)) {
      const name = typeParameterName(parameter);
      if (name) scope.shadowedTypes.add(name);
    }
    const ownName = identifierName(candidate.id);
    if (ownName) ensureBinding(ownName, scope, candidate);
    const parameters = childNodes(candidate.params);
    for (const parameter of parameters) declarePattern(parameter, scope);
    let state = predeclareVars(candidate.body, scope, widened);
    for (const [index, parameter] of parameters.entries()) {
      const normalized = unwrapPattern(parameter);
      const annotation = normalized?.typeAnnotation ?? parameter.typeAnnotation;
      const value = (transactionCallback && index === 0) || trustedType(annotation, scope) ? T : U;
      const trustedBindings = trustedPatternBindings(parameter, annotation, scope);
      const initialized = evalPattern(parameter, value, { scope }, state, scope, trustedBindings);
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
        if (simpleName) {
          const binding = resolveBinding(simpleName, targetScope);
          const sqlText = staticSqlTextValue(init, ctx.scope);
          if (binding && sqlText !== undefined) staticSqlTexts.set(binding, sqlText);
          if (candidate.kind === 'const') {
            const text = staticStringValue(init, ctx.scope);
            if (binding && text !== undefined) staticStrings.set(binding, text);
          }
        }
        const functionValue = unwrapExpression(init);
        if (simpleName && functionValue?.type === 'Identifier') {
          const binding = resolveBinding(simpleName, targetScope);
          const sourceBinding = resolveBinding(functionValue.name as string, ctx.scope);
          const aliasedFunction = sourceBinding ? functionBindings.get(sourceBinding) : undefined;
          if (binding && aliasedFunction) functionBindings.set(binding, aliasedFunction);
        }
        if (simpleName && functionValue?.type === 'ObjectExpression') {
          const binding = resolveBinding(simpleName, targetScope);
          const properties = new Map<string, AstNode>();
          for (const property of childNodes(functionValue.properties)) {
            const propertyName = property.computed
              ? staticComputedPropertyName(property.key)
              : identifierName(property.key);
            const propertyFunction = unwrapExpression(property.value);
            if (
              propertyName &&
              propertyFunction &&
              ['FunctionExpression', 'ArrowFunctionExpression'].includes(propertyFunction.type)
            ) {
              properties.set(propertyName, propertyFunction);
              functionParents.set(propertyFunction, ctx.scope);
            }
          }
          if (binding && properties.size > 0) objectFunctions.set(binding, properties);
        }
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
        const evaluated = init ? evalExpr(init, ctx, next) : { normal: { state: next, value: D } };
        if (!evaluated.normal) return evaluated;
        const id = node(declaration.id);
        const annotated = trustedType(id?.typeAnnotation, ctx.scope);
        const value = annotated ? T : evaluated.normal.value;
        const trustedBindings = trustedPatternBindings(
          declaration.id,
          id?.typeAnnotation,
          ctx.scope,
        );
        const bound = evalPattern(
          declaration.id,
          value,
          ctx,
          evaluated.normal.state,
          targetScope,
          trustedBindings,
          evaluated.normal.elements,
        );
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
        initialState = predeclareVars(candidate.body, ctx.scope, initialState);
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
      case 'TSImportEqualsDeclaration': {
        const binding = resolveBinding(identifierName(candidate.id) ?? '', ctx.scope);
        const next = store(binding, U, state);
        const reference = node(candidate.moduleReference);
        if (reference?.type === 'TSExternalModuleReference') {
          const expression = node(reference.expression);
          const evaluated = expression
            ? evalExpr(expression, ctx, next)
            : { normal: { state: next, value: U } };
          const flow = emptyFlow(evaluated.normal?.state);
          flow.throws = evaluated.throws;
          return flow;
        }
        return emptyFlow(next);
      }
      case 'TSEnumDeclaration': {
        const binding = resolveBinding(identifierName(candidate.id) ?? '', ctx.scope);
        const initialized = store(binding, U, state);
        const evaluated = evalList(
          childNodes(candidate.members).map((member) => member.initializer),
          ctx,
          initialized,
        );
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
        return execWhile(candidate, ctx, state, attachedLabels);
      case 'DoWhileStatement': {
        const body = node(candidate.body);
        if (!body) return emptyFlow(state);
        const first = execStmt(body, ctx, state, attachedLabels);
        const consumed = consumeLoopCompletions(first, attachedLabels);
        const rest = consumed.rest;
        rest.normal = consumed.exit;
        if (consumed.backedge) {
          const later = execWhile(candidate, ctx, consumed.backedge, attachedLabels);
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
        for (const specifier of childNodes(candidate.specifiers))
          escapeValue(specifier.local, ctx.scope);
        const declaration = node(candidate.declaration);
        if (!declaration) return emptyFlow(state);
        if (declaration.type === 'VariableDeclaration') {
          const flow = execStmt(declaration, ctx, state);
          for (const item of childNodes(declaration.declarations)) escapeValue(item.id, ctx.scope);
          return flow;
        }
        if (declaration.type === 'Identifier') {
          escapeValue(declaration, ctx.scope);
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

  const finalFlow = execStmt(program, { scope: root }, initialState);
  const finalState = finalFlow.normal ?? initialState;
  for (const escaped of escapedFunctions)
    visitFunction(escaped, functionBindingsScope(escaped), finalState, false);
  for (let index = 0; index < pendingFunctions.length; index += 1) {
    const pending = pendingFunctions[index];
    if (!pending || analyzedFunctions.has(pending.candidate)) continue;
    visitFunction(pending.candidate, pending.parent, pending.state, false);
  }
  return {
    writes: [...writes.values()].sort((left, right) => left.index - right.index),
    internalApplyMarkers: [...internalApplyMarkers.values()].sort(
      (left, right) => left.index - right.index,
    ),
  };
}
