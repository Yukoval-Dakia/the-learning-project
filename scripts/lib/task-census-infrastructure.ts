import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import type { CallerEvidence } from './task-census-source';

export interface RegistrationEvidence extends CallerEvidence {
  readonly registration: 'manifest-job' | 'legacy-handler';
  readonly registrationName: string;
  readonly entryFile: string;
}

export interface RunLogContractEvidence {
  readonly schemaTaskKindColumn: boolean;
  readonly runnerCatalogGuard: boolean;
  readonly lifecycleTaskKind: boolean;
  readonly startWriterTaskKind: boolean;
}

interface RegistrationRoot {
  readonly registration: RegistrationEvidence['registration'];
  readonly registrationName: string;
  readonly entryFile: string;
}

function normalize(relativePath: string): string {
  return relativePath.replaceAll(path.sep, '/');
}

function sourceFileFor(sourceRoot: string, relativeFile: string): ts.SourceFile | undefined {
  const filePath = path.join(sourceRoot, relativeFile);
  if (!existsSync(filePath)) return undefined;
  return ts.createSourceFile(
    filePath,
    readFileSync(filePath, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
}

function resolveSourceModule(
  sourceRoot: string,
  fromRelativeFile: string,
  moduleSpecifier: string,
): string | undefined {
  let base: string;
  if (moduleSpecifier.startsWith('@/')) {
    base = moduleSpecifier.slice(2);
  } else if (moduleSpecifier.startsWith('.')) {
    base = path.join(path.dirname(fromRelativeFile), moduleSpecifier);
  } else {
    return undefined;
  }
  for (const candidate of [`${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts')]) {
    const normalized = normalize(candidate);
    if (existsSync(path.join(sourceRoot, normalized))) return normalized;
  }
  return undefined;
}

function importedSourceModules(sourceRoot: string, relativeFile: string): readonly string[] {
  const sourceFile = sourceFileFor(sourceRoot, relativeFile);
  if (!sourceFile) return [];
  const imports = new Set<string>();
  const add = (moduleSpecifier: string): void => {
    const resolved = resolveSourceModule(sourceRoot, relativeFile, moduleSpecifier);
    if (resolved) imports.add(resolved);
  };
  const visit = (node: ts.Node): void => {
    if (
      (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
      node.moduleSpecifier !== undefined &&
      ts.isStringLiteralLike(node.moduleSpecifier)
    ) {
      add(node.moduleSpecifier.text);
    } else if (
      ts.isCallExpression(node) &&
      node.expression.kind === ts.SyntaxKind.ImportKeyword &&
      node.arguments[0] !== undefined &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      add(node.arguments[0].text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return [...imports];
}

function reachableFiles(sourceRoot: string, entryFile: string): ReadonlySet<string> {
  const visited = new Set<string>();
  const pending = [entryFile];
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined || visited.has(current)) continue;
    visited.add(current);
    for (const imported of importedSourceModules(sourceRoot, current)) {
      if (!visited.has(imported)) pending.push(imported);
    }
  }
  return visited;
}

function property(object: ts.ObjectLiteralExpression, name: string): ts.Expression | undefined {
  for (const item of object.properties) {
    if (
      ts.isPropertyAssignment(item) &&
      ((ts.isIdentifier(item.name) && item.name.text === name) ||
        (ts.isStringLiteralLike(item.name) && item.name.text === name))
    ) {
      return item.initializer;
    }
  }
  return undefined;
}

function composedManifestFiles(sourceRoot: string): readonly string[] {
  const relativeFile = 'src/capabilities/index.ts';
  const sourceFile = sourceFileFor(sourceRoot, relativeFile);
  if (!sourceFile) return [];
  const imports = new Map<string, string>();
  for (const statement of sourceFile.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !statement.importClause?.namedBindings ||
      !ts.isNamedImports(statement.importClause.namedBindings) ||
      !ts.isStringLiteralLike(statement.moduleSpecifier)
    ) {
      continue;
    }
    const resolved = resolveSourceModule(sourceRoot, relativeFile, statement.moduleSpecifier.text);
    if (!resolved) continue;
    for (const element of statement.importClause.namedBindings.elements) {
      imports.set(element.name.text, resolved);
    }
  }
  const result: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === 'capabilities' &&
      node.initializer !== undefined &&
      ts.isArrayLiteralExpression(node.initializer)
    ) {
      for (const element of node.initializer.elements) {
        if (ts.isIdentifier(element)) {
          const manifest = imports.get(element.text);
          if (manifest) result.push(manifest);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return result;
}

function manifestJobRoots(sourceRoot: string): readonly RegistrationRoot[] {
  const roots: RegistrationRoot[] = [];
  for (const manifestFile of composedManifestFiles(sourceRoot)) {
    const sourceFile = sourceFileFor(sourceRoot, manifestFile);
    if (!sourceFile) continue;
    const visit = (node: ts.Node): void => {
      if (!ts.isObjectLiteralExpression(node)) {
        ts.forEachChild(node, visit);
        return;
      }
      const name = property(node, 'name');
      const queue = property(node, 'queue');
      const load = property(node, 'load');
      if (
        name !== undefined &&
        ts.isStringLiteralLike(name) &&
        queue !== undefined &&
        ts.isStringLiteralLike(queue) &&
        load !== undefined
      ) {
        const findImport = (candidate: ts.Node): string | undefined => {
          if (
            ts.isCallExpression(candidate) &&
            candidate.expression.kind === ts.SyntaxKind.ImportKeyword &&
            candidate.arguments[0] !== undefined &&
            ts.isStringLiteralLike(candidate.arguments[0])
          ) {
            return resolveSourceModule(sourceRoot, manifestFile, candidate.arguments[0].text);
          }
          let found: string | undefined;
          ts.forEachChild(candidate, (child) => {
            found ??= findImport(child);
          });
          return found;
        };
        const entryFile = findImport(load);
        if (entryFile) {
          roots.push({
            registration: 'manifest-job',
            registrationName: name.text,
            entryFile,
          });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return roots;
}

function legacyHandlerRoots(sourceRoot: string): readonly RegistrationRoot[] {
  const relativeFile = 'src/server/boss/handlers.ts';
  const sourceFile = sourceFileFor(sourceRoot, relativeFile);
  if (!sourceFile) return [];
  const imports = new Map<string, string>();
  for (const statement of sourceFile.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !statement.importClause?.namedBindings ||
      !ts.isNamedImports(statement.importClause.namedBindings) ||
      !ts.isStringLiteralLike(statement.moduleSpecifier)
    ) {
      continue;
    }
    const resolved = resolveSourceModule(sourceRoot, relativeFile, statement.moduleSpecifier.text);
    if (!resolved) continue;
    for (const element of statement.importClause.namedBindings.elements) {
      imports.set(element.name.text, resolved);
    }
  }
  const roots = new Map<string, RegistrationRoot>();
  const addImportedCall = (call: ts.CallExpression, registrationName: string): void => {
    const target = call.expression;
    if (!ts.isIdentifier(target)) return;
    const entryFile = imports.get(target.text);
    if (entryFile) {
      roots.set(`${registrationName}:${entryFile}`, {
        registration: 'legacy-handler',
        registrationName,
        entryFile,
      });
    }
  };
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      if (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'work') {
        const queue = node.arguments[0];
        const handler = node.arguments[2] ?? node.arguments[1];
        const registrationName =
          queue !== undefined && ts.isStringLiteralLike(queue)
            ? queue.text
            : (queue?.getText(sourceFile) ?? 'boss.work');
        if (handler !== undefined && ts.isCallExpression(handler)) {
          addImportedCall(handler, registrationName);
        }
      } else if (
        ts.isIdentifier(node.expression) &&
        /^register.*Handlers$/.test(node.expression.text)
      ) {
        addImportedCall(node, node.expression.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return [...roots.values()];
}

export function collectRegistrationEvidence(
  sourceRoot: string,
  callersByKind: Readonly<Record<string, readonly CallerEvidence[]>>,
): readonly RegistrationEvidence[] {
  const evidence: RegistrationEvidence[] = [];
  const roots = [...manifestJobRoots(sourceRoot), ...legacyHandlerRoots(sourceRoot)];
  for (const root of roots) {
    const reachable = reachableFiles(sourceRoot, root.entryFile);
    for (const callers of Object.values(callersByKind)) {
      for (const caller of callers) {
        if (reachable.has(caller.file)) evidence.push({ ...caller, ...root });
      }
    }
  }
  return evidence.sort((left, right) =>
    `${left.registration}:${left.registrationName}:${left.kind}:${left.file}`.localeCompare(
      `${right.registration}:${right.registrationName}:${right.kind}:${right.file}`,
    ),
  );
}

function namedProperty(
  object: ts.ObjectLiteralExpression,
  name: string,
): ts.PropertyAssignment | ts.ShorthandPropertyAssignment | undefined {
  return object.properties.find(
    (item): item is ts.PropertyAssignment | ts.ShorthandPropertyAssignment =>
      (ts.isPropertyAssignment(item) || ts.isShorthandPropertyAssignment(item)) &&
      ((ts.isIdentifier(item.name) && item.name.text === name) ||
        (ts.isStringLiteralLike(item.name) && item.name.text === name)),
  );
}

function isIdentifierText(node: ts.Node | undefined, text: string): boolean {
  return node !== undefined && ts.isIdentifier(node) && node.text === text;
}

function isTypeReferenceText(node: ts.TypeNode | undefined, text: string): boolean {
  return (
    node !== undefined &&
    ts.isTypeReferenceNode(node) &&
    ts.isIdentifier(node.typeName) &&
    node.typeName.text === text
  );
}

function isObjectReference(node: ts.Node | undefined, name: string): boolean {
  return name === 'this'
    ? node !== undefined && node.kind === ts.SyntaxKind.ThisKeyword
    : isIdentifierText(node, name);
}

function isPropertyAccess(
  node: ts.Node | undefined,
  objectName: string,
  propertyName: string,
): boolean {
  return (
    node !== undefined &&
    ts.isPropertyAccessExpression(node) &&
    isObjectReference(node.expression, objectName) &&
    node.name.text === propertyName
  );
}

function isElementAccess(node: ts.Node | undefined, objectName: string, keyName: string): boolean {
  return (
    node !== undefined &&
    ts.isElementAccessExpression(node) &&
    isIdentifierText(node.expression, objectName) &&
    isIdentifierText(node.argumentExpression, keyName)
  );
}

function findNode(sourceFile: ts.SourceFile, predicate: (node: ts.Node) => boolean): boolean {
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (predicate(node)) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

function isCallTo(node: ts.Node | undefined, name: string): node is ts.CallExpression {
  return node !== undefined && ts.isCallExpression(node) && isIdentifierText(node.expression, name);
}

function hasSchemaTaskKindColumn(sourceRoot: string): boolean {
  const sourceFile = sourceFileFor(sourceRoot, 'src/db/schema.ts');
  if (!sourceFile) return false;
  return findNode(sourceFile, (node) => {
    if (
      !ts.isVariableDeclaration(node) ||
      !isIdentifierText(node.name, 'ai_task_runs') ||
      !isCallTo(node.initializer, 'pgTable')
    ) {
      return false;
    }
    const tableName = node.initializer.arguments[0];
    const columns = node.initializer.arguments[1];
    if (
      tableName === undefined ||
      !ts.isStringLiteralLike(tableName) ||
      tableName.text !== 'ai_task_runs' ||
      columns === undefined ||
      !ts.isObjectLiteralExpression(columns)
    ) {
      return false;
    }
    const taskKind = namedProperty(columns, 'task_kind');
    if (!taskKind || !ts.isPropertyAssignment(taskKind)) return false;
    const notNullCall = taskKind.initializer;
    if (
      !ts.isCallExpression(notNullCall) ||
      !ts.isPropertyAccessExpression(notNullCall.expression) ||
      notNullCall.expression.name.text !== 'notNull'
    ) {
      return false;
    }
    const textCall = notNullCall.expression.expression;
    const columnName = ts.isCallExpression(textCall) ? textCall.arguments[0] : undefined;
    return (
      isCallTo(textCall, 'text') &&
      columnName !== undefined &&
      ts.isStringLiteralLike(columnName) &&
      columnName.text === 'task_kind'
    );
  });
}

function hasRunnerCatalogGuard(sourceRoot: string): boolean {
  const sourceFile = sourceFileFor(sourceRoot, 'src/server/ai/runner.ts');
  if (!sourceFile) return false;
  let guarded = false;
  let catalogRead = false;
  let lifecycleKind = false;
  const visit = (node: ts.Node): void => {
    if (ts.isIfStatement(node) && ts.isPrefixUnaryExpression(node.expression)) {
      const guardCall = node.expression.operand;
      guarded ||=
        node.expression.operator === ts.SyntaxKind.ExclamationToken &&
        isCallTo(guardCall, 'isKnownTask') &&
        isIdentifierText(guardCall.arguments[0], 'kind');
    } else if (isElementAccess(node, 'tasks', 'kind')) {
      catalogRead = true;
    } else if (
      ts.isCallExpression(node) &&
      isIdentifierText(node.expression, 'createRunLifecycle')
    ) {
      const config = node.arguments[0];
      lifecycleKind ||=
        config !== undefined &&
        ts.isObjectLiteralExpression(config) &&
        namedProperty(config, 'kind')?.getText(sourceFile) === 'kind';
    }
    ts.forEachChild(node, visit);
  };
  for (const statement of sourceFile.statements) {
    if (
      ts.isFunctionDeclaration(statement) &&
      isIdentifierText(statement.name, 'runTask') &&
      statement.body
    ) {
      visit(statement.body);
    }
  }
  return guarded && catalogRead && lifecycleKind;
}

function hasLifecycleTaskKind(sourceRoot: string): boolean {
  const sourceFile = sourceFileFor(sourceRoot, 'src/server/ai/run-lifecycle.ts');
  if (!sourceFile) return false;
  let configTyped = false;
  let lifecycleTyped = false;
  let assigned = false;
  let writerReceivesKind = false;
  const visit = (node: ts.Node): void => {
    if (
      ts.isPropertySignature(node) &&
      isIdentifierText(node.name, 'kind') &&
      isTypeReferenceText(node.type, 'TaskKind')
    ) {
      configTyped = true;
    } else if (
      ts.isPropertyDeclaration(node) &&
      isIdentifierText(node.name, 'kind') &&
      isTypeReferenceText(node.type, 'TaskKind')
    ) {
      lifecycleTyped = true;
    } else if (
      ts.isBinaryExpression(node) &&
      node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
      isPropertyAccess(node.left, 'this', 'kind') &&
      ts.isPropertyAccessExpression(node.right) &&
      isIdentifierText(node.right.expression, 'config') &&
      node.right.name.text === 'kind'
    ) {
      assigned = true;
    } else if (isCallTo(node, 'writeAiTaskRunStarted')) {
      const entry = node.arguments[1];
      if (entry !== undefined && ts.isObjectLiteralExpression(entry)) {
        const taskKind = namedProperty(entry, 'task_kind');
        writerReceivesKind =
          taskKind !== undefined &&
          ts.isPropertyAssignment(taskKind) &&
          isPropertyAccess(taskKind.initializer, 'this', 'kind');
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return configTyped && lifecycleTyped && assigned && writerReceivesKind;
}

function hasStartWriterTaskKind(sourceRoot: string): boolean {
  const sourceFile = sourceFileFor(sourceRoot, 'src/server/ai/log.ts');
  if (!sourceFile) return false;
  let entryTyped = false;
  let writerTyped = false;
  let insertMapped = false;
  const visit = (node: ts.Node): void => {
    if (
      ts.isPropertySignature(node) &&
      isIdentifierText(node.name, 'task_kind') &&
      isTypeReferenceText(node.type, 'TaskKind')
    ) {
      entryTyped = true;
    } else if (
      ts.isFunctionDeclaration(node) &&
      isIdentifierText(node.name, 'writeAiTaskRunStarted')
    ) {
      const entryParameter = node.parameters[1];
      writerTyped =
        entryParameter !== undefined &&
        isIdentifierText(entryParameter.name, 'entry') &&
        isTypeReferenceText(entryParameter.type, 'AiTaskRunStartEntry');
      if (node.body) {
        insertMapped = findNode(sourceFile, (candidate) => {
          if (!node.body || candidate.pos < node.body.pos || candidate.end > node.body.end) {
            return false;
          }
          if (
            !ts.isCallExpression(candidate) ||
            !ts.isPropertyAccessExpression(candidate.expression) ||
            candidate.expression.name.text !== 'values'
          ) {
            return false;
          }
          const values = candidate.arguments[0];
          if (values === undefined || !ts.isObjectLiteralExpression(values)) return false;
          const taskKind = namedProperty(values, 'task_kind');
          return (
            taskKind !== undefined &&
            ts.isPropertyAssignment(taskKind) &&
            isPropertyAccess(taskKind.initializer, 'entry', 'task_kind')
          );
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return entryTyped && writerTyped && insertMapped;
}

export function inspectRunLogContract(sourceRoot: string): RunLogContractEvidence {
  return {
    schemaTaskKindColumn: hasSchemaTaskKindColumn(sourceRoot),
    runnerCatalogGuard: hasRunnerCatalogGuard(sourceRoot),
    lifecycleTaskKind: hasLifecycleTaskKind(sourceRoot),
    startWriterTaskKind: hasStartWriterTaskKind(sourceRoot),
  };
}

export function hasCapabilityJobRegistrationPath(sourceRoot: string): boolean {
  const startWorker = sourceFileFor(sourceRoot, 'src/server/boss/start-worker.ts');
  const registrar = sourceFileFor(sourceRoot, 'src/server/boss/register-capability-jobs.ts');
  if (!startWorker || !registrar || composedManifestFiles(sourceRoot).length === 0) return false;

  const startCallsRegistrar = findNode(startWorker, (node) => {
    if (!isCallTo(node, 'registerCapabilityJobs')) return false;
    return (
      isIdentifierText(node.arguments[0], 'boss') &&
      isIdentifierText(node.arguments[1], 'db') &&
      isIdentifierText(node.arguments[2], 'capabilities')
    );
  });
  const loadsFactory = findNode(registrar, (node) => {
    if (!ts.isAwaitExpression(node) || !ts.isCallExpression(node.expression)) return false;
    const call = node.expression;
    return (
      ts.isPropertyAccessExpression(call.expression) &&
      isIdentifierText(call.expression.expression, 'decl') &&
      call.expression.name.text === 'load'
    );
  });
  const mountsHandler = findNode(registrar, (node) => {
    if (!ts.isAwaitExpression(node) || !ts.isCallExpression(node.expression)) return false;
    const call = node.expression;
    if (
      !ts.isPropertyAccessExpression(call.expression) ||
      !isIdentifierText(call.expression.expression, 'boss') ||
      call.expression.name.text !== 'work'
    ) {
      return false;
    }
    const queue = call.arguments[0];
    return (
      queue !== undefined &&
      ts.isPropertyAccessExpression(queue) &&
      isIdentifierText(queue.expression, 'decl') &&
      queue.name.text === 'name'
    );
  });
  return startCallsRegistrar && loadsFactory && mountsHandler;
}
