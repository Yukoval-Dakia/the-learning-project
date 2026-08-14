/* SIZE_OK: this AST census keeps one shared parse/import-closure model and one violation vocabulary. */
import { existsSync, lstatSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, dirname, extname, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';
import {
  type DirectImporter,
  type DirectImporterKind,
  IMPORTED_FETCH_EXCEPTIONS,
  PROVIDER_LANES,
  PROVIDER_RUNTIME_SDK_IMPORTS,
  PRUNED_MISCONCEPTION_MODULES,
  type ProviderConfigurationTruth,
  type ProviderLane,
  type SourceEvidence,
  validateProviderLaneInventory,
} from './provider-lane-inventory';

const SOURCE_FILE = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/u;
const TEST_FILE =
  /\.(?:unit|db|migration|integration|e2e)?\.?(?:test|spec)\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/u;
const EXCLUDED_SOURCE_DIRECTORIES = new Set([
  '__fixtures__',
  '__generated__',
  'fixtures',
  'generated',
  'vendor',
]);
const OPERATOR_PROVIDER_MARKERS = [
  'api.anthropic.com',
  'api.xiaomimimo.com',
  'dashscope.aliyuncs.com',
  'ocr.tencentcloudapi.com',
  'open.bigmodel.cn',
  '/chat/completions',
  '/embeddings',
  'layout_parsing',
] as const;

export type ProviderWireFinding = {
  readonly kind:
    | 'dashscope-embedding-fetch'
    | 'glm-edge-reconcile-fetch'
    | 'glm-memory-reconcile-fetch'
    | 'glm-ocr-layout-parsing-fetch'
    | 'mem0-model-bearing-operation'
    | 'xiaomi-vision-preflight-sdk'
    | 'tencent-question-mark-agent-sdk'
    | 'unclassified-provider-fetch';
  readonly call: string;
  readonly path: string;
};

export type ProviderLaneViolation = {
  readonly path: string;
  readonly reason: string;
};

export type ProviderLaneAuditResult = {
  readonly ok: boolean;
  readonly findings: readonly ProviderWireFinding[];
  readonly violations: readonly ProviderLaneViolation[];
};

type SourceFacts = {
  readonly imports: readonly string[];
  readonly calls: readonly string[];
  readonly envReads: readonly string[];
  readonly literals: readonly string[];
  readonly importedFetches: readonly ImportedFetchBinding[];
};

type ImportedFetchBinding = {
  readonly source: string;
  readonly local: string;
};

type SourceImportEdge = {
  readonly path: string;
  readonly source: string;
  readonly kind: DirectImporterKind;
  readonly target?: string;
  readonly bindings?: readonly RuntimeImportBinding[];
};

type RuntimeImportBinding = {
  readonly imported: string;
  readonly local: string;
};

const SUPPORTED_SOURCE_EXTENSIONS = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];
const DEFAULT_FETCH_PACKAGES = new Set(['node-fetch', 'cross-fetch']);

function sourceFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  const files: string[] = [];
  for (const entry of readdirSync(root).sort((left, right) => left.localeCompare(right))) {
    const path = resolve(root, entry);
    const stats = lstatSync(path);
    if (stats.isSymbolicLink()) {
      throw new Error(`${path}: symbolic link found while collecting source files`);
    }
    if (stats.isDirectory() && !EXCLUDED_SOURCE_DIRECTORIES.has(entry)) {
      files.push(...sourceFiles(path));
    } else if (SOURCE_FILE.test(entry) && !TEST_FILE.test(entry)) files.push(path);
  }
  return files;
}

function backendSourceFiles(root: string): string[] {
  const files = new Set([
    ...sourceFiles(resolve(root, 'src')),
    ...sourceFiles(resolve(root, 'server')),
  ]);
  for (const entry of ['server/index.ts', 'scripts/worker.ts']) {
    const entryPath = resolve(root, entry);
    if (!existsSync(entryPath)) continue;
    if (lstatSync(entryPath).isSymbolicLink()) {
      throw new Error(`${entryPath}: symbolic link found while collecting source files`);
    }
    files.add(entryPath);
  }
  return [...files]
    .filter((path) => {
      const pathFromProject = projectPath(root, path);
      return (
        pathFromProject.startsWith('server/') ||
        pathFromProject.startsWith('src/server/') ||
        pathFromProject === 'scripts/worker.ts' ||
        (pathFromProject.startsWith('src/capabilities/') && !pathFromProject.includes('/ui/'))
      );
    })
    .sort((left, right) => projectPath(root, left).localeCompare(projectPath(root, right)));
}

function scriptKind(filename: string): ts.ScriptKind {
  switch (extname(filename)) {
    case '.js':
    case '.mjs':
    case '.cjs':
      return ts.ScriptKind.JS;
    case '.jsx':
      return ts.ScriptKind.JSX;
    case '.tsx':
      return ts.ScriptKind.TSX;
    default:
      return ts.ScriptKind.TS;
  }
}

function parseSource(code: string, filename: string): ts.SourceFile {
  return ts.createSourceFile(filename, code, ts.ScriptTarget.Latest, true, scriptKind(filename));
}

function textValue(node: ts.Node | undefined): string | undefined {
  return node && ts.isStringLiteralLike(node) ? node.text : undefined;
}

function expressionName(value: ts.Expression | undefined): string | undefined {
  if (!value) return undefined;
  if (ts.isIdentifier(value)) return value.text;
  if (ts.isPropertyAccessExpression(value)) {
    const object = expressionName(value.expression);
    return object ? `${object}.${value.name.text}` : undefined;
  }
  if (!ts.isElementAccessExpression(value)) return undefined;
  const object = expressionName(value.expression);
  const property = textValue(value.argumentExpression);
  return object && property ? `${object}.${property}` : undefined;
}

function callName(callee: ts.LeftHandSideExpression): string | undefined {
  const name = expressionName(callee);
  return name === 'globalThis.fetch' || name === 'global.fetch' ? 'fetch' : name;
}

function globalFetchMemberName(node: ts.Expression | undefined): string | undefined {
  const name = expressionName(node);
  return name === 'globalThis.fetch' || name === 'global.fetch' ? 'fetch' : undefined;
}

function envReadName(node: ts.Node): string | undefined {
  if (!ts.isPropertyAccessExpression(node)) return undefined;
  const environment = node.expression;
  if (!ts.isPropertyAccessExpression(environment)) return undefined;
  return ts.isIdentifier(environment.expression) &&
    environment.expression.text === 'process' &&
    environment.name.text === 'env'
    ? node.name.text
    : undefined;
}

function helperEnvReadName(node: ts.Node): string | undefined {
  if (!ts.isCallExpression(node) || !ts.isIdentifier(node.expression)) return undefined;
  if (node.expression.text !== 'optionalEnv' && node.expression.text !== 'requireEnv') {
    return undefined;
  }
  return textValue(node.arguments[1]);
}

function inspectSource(code: string, filename: string): SourceFacts {
  const sourceFile = parseSource(code, filename);
  const imports = new Set<string>();
  const calls: string[] = [];
  const requestAliases = new Map<string, string>();
  const importedFetches: ImportedFetchBinding[] = [];
  const envReads = new Set<string>();
  const literals = new Set<string>();

  function visit(node: ts.Node): void {
    const literal = textValue(node);
    if (literal) literals.add(literal);
    if (ts.isImportDeclaration(node)) {
      const source = textValue(node.moduleSpecifier);
      if (source) {
        imports.add(source);
        const clause = node.importClause;
        if (clause && !clause.isTypeOnly) {
          if (clause.name && DEFAULT_FETCH_PACKAGES.has(source)) {
            const local = clause.name.text;
            importedFetches.push({ source, local });
            requestAliases.set(local, `imported-fetch:${source}:${local}`);
          }
          if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
            for (const specifier of clause.namedBindings.elements) {
              if (specifier.isTypeOnly) continue;
              const imported = specifier.propertyName?.text ?? specifier.name.text;
              if (imported !== 'fetch') continue;
              const local = specifier.name.text;
              importedFetches.push({ source, local });
              requestAliases.set(local, `imported-fetch:${source}:${local}`);
            }
          }
        }
      }
    }
    if (ts.isVariableDeclaration(node)) {
      if (ts.isIdentifier(node.name) && node.initializer && ts.isIdentifier(node.initializer)) {
        requestAliases.set(node.name.text, node.initializer.text);
      }
      if (ts.isIdentifier(node.name)) {
        const globalFetch = globalFetchMemberName(node.initializer);
        if (globalFetch) requestAliases.set(node.name.text, globalFetch);
      }
      if (
        ts.isObjectBindingPattern(node.name) &&
        node.initializer &&
        ts.isIdentifier(node.initializer) &&
        (node.initializer.text === 'globalThis' || node.initializer.text === 'global')
      ) {
        for (const element of node.name.elements) {
          const imported = element.propertyName
            ? (textValue(element.propertyName) ??
              (ts.isIdentifier(element.propertyName) ? element.propertyName.text : undefined))
            : ts.isIdentifier(element.name)
              ? element.name.text
              : undefined;
          if (imported === 'fetch' && ts.isIdentifier(element.name)) {
            requestAliases.set(element.name.text, 'fetch');
          }
        }
      }
    }
    if (ts.isCallExpression(node)) {
      const name = callName(node.expression);
      if (name) calls.push(name);
    }
    const envRead = envReadName(node);
    if (envRead) envReads.add(envRead);
    const helperEnvRead = helperEnvReadName(node);
    if (helperEnvRead) envReads.add(helperEnvRead);
    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return {
    imports: [...imports].sort((left, right) => left.localeCompare(right)),
    calls: calls
      .map((call) => {
        let resolved = call;
        const visited = new Set<string>();
        while (requestAliases.has(resolved) && !visited.has(resolved)) {
          visited.add(resolved);
          resolved = requestAliases.get(resolved) ?? resolved;
        }
        return resolved === 'fetch' ||
          resolved === 'fetchImpl' ||
          resolved.startsWith('imported-fetch:')
          ? resolved
          : call;
      })
      .sort((left, right) => left.localeCompare(right)),
    envReads: [...envReads].sort((left, right) => left.localeCompare(right)),
    literals: [...literals].sort((left, right) => left.localeCompare(right)),
    importedFetches: importedFetches.sort(
      (left, right) =>
        left.source.localeCompare(right.source) || left.local.localeCompare(right.local),
    ),
  };
}

function stripSupportedExtension(path: string): string {
  const extension = extname(path);
  return SUPPORTED_SOURCE_EXTENSIONS.includes(extension) ? path.slice(0, -extension.length) : path;
}

function importKind(node: ts.ImportDeclaration): DirectImporterKind {
  const clause = node.importClause;
  if (clause?.isTypeOnly) return 'type';
  if (!clause?.namedBindings || !ts.isNamedImports(clause.namedBindings)) return 'runtime';
  return clause.namedBindings.elements.length > 0 &&
    clause.namedBindings.elements.every((specifier) => specifier.isTypeOnly)
    ? 'type'
    : 'runtime';
}

function resolveImportTarget(root: string, importer: string, source: string): string | undefined {
  const localPath = source.startsWith('@/')
    ? resolve(root, 'src', source.slice(2))
    : source.startsWith('.')
      ? resolve(dirname(importer), source)
      : '';
  if (!localPath) return undefined;
  const explicitExtension = SUPPORTED_SOURCE_EXTENSIONS.includes(extname(localPath));
  const unextended = explicitExtension ? stripSupportedExtension(localPath) : localPath;
  const candidates =
    explicitExtension && existsSync(localPath)
      ? [localPath]
      : [
          ...SUPPORTED_SOURCE_EXTENSIONS.map((extension) => `${unextended}${extension}`),
          ...SUPPORTED_SOURCE_EXTENSIONS.map((extension) =>
            resolve(unextended, `index${extension}`),
          ),
        ];
  for (const candidate of candidates) {
    if (!existsSync(candidate)) continue;
    if (lstatSync(candidate).isSymbolicLink()) {
      throw new Error(`${candidate}: symbolic link found while resolving source import`);
    }
    if (statSync(candidate).isFile()) return candidate;
  }
  return undefined;
}

function importSourceFiles(root: string): string[] {
  const files = new Set([
    ...sourceFiles(resolve(root, 'src')),
    ...sourceFiles(resolve(root, 'server')),
  ]);
  for (const entry of ['server/index.ts', 'scripts/worker.ts']) {
    const entryPath = resolve(root, entry);
    if (!existsSync(entryPath)) continue;
    if (lstatSync(entryPath).isSymbolicLink()) {
      throw new Error(`${entryPath}: symbolic link found while collecting source files`);
    }
    files.add(entryPath);
  }
  return [...files].sort((left, right) =>
    projectPath(root, left).localeCompare(projectPath(root, right)),
  );
}

function collectImportEdgesFromSource(
  root: string,
  path: string,
  code: string,
): {
  readonly edges: readonly SourceImportEdge[];
  readonly unsupportedDynamicImports: readonly string[];
} {
  const sourceFile = parseSource(code, path);
  const edges: SourceImportEdge[] = [];
  const unsupportedDynamicImports: string[] = [];
  const addEdge = (
    source: string,
    kind: DirectImporterKind,
    bindings: readonly RuntimeImportBinding[] = [],
  ): void => {
    edges.push({
      path: projectPath(root, path),
      source,
      kind,
      target: resolveImportTarget(root, path, source),
      bindings,
    });
  };
  function visit(node: ts.Node): void {
    if (ts.isImportDeclaration(node)) {
      const source = textValue(node.moduleSpecifier);
      if (source) {
        const kind = importKind(node);
        const clause = node.importClause;
        const bindings =
          kind === 'type' || !clause
            ? []
            : [
                ...(clause.name ? [{ imported: 'default', local: clause.name.text }] : []),
                ...(clause.namedBindings && ts.isNamespaceImport(clause.namedBindings)
                  ? [{ imported: '*', local: clause.namedBindings.name.text }]
                  : []),
                ...(clause.namedBindings && ts.isNamedImports(clause.namedBindings)
                  ? clause.namedBindings.elements.flatMap((specifier): RuntimeImportBinding[] =>
                      specifier.isTypeOnly
                        ? []
                        : [
                            {
                              imported: specifier.propertyName?.text ?? specifier.name.text,
                              local: specifier.name.text,
                            },
                          ],
                    )
                  : []),
              ];
        addEdge(source, kind, bindings);
      }
    }
    if (ts.isExportDeclaration(node)) {
      const source = textValue(node.moduleSpecifier);
      if (source) addEdge(source, 're-export');
    }
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) {
      const source = textValue(node.moduleReference.expression);
      if (source) addEdge(source, 'runtime', [{ imported: '*', local: node.name.text }]);
      else unsupportedDynamicImports.push(projectPath(root, path));
    }
    if (ts.isCallExpression(node)) {
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const source = textValue(node.arguments[0]);
        if (source) addEdge(source, 'dynamic');
        else unsupportedDynamicImports.push(projectPath(root, path));
      }
      if (ts.isIdentifier(node.expression) && node.expression.text === 'require') {
        const source = textValue(node.arguments[0]);
        if (source) addEdge(source, 'runtime');
        else unsupportedDynamicImports.push(projectPath(root, path));
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  return { edges, unsupportedDynamicImports };
}

function runtimeSourceClosure(root: string, roots: readonly string[]): string[] {
  const pending = [...roots];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const path = pending.pop();
    if (!path || visited.has(path)) continue;
    visited.add(path);
    const scan = collectImportEdgesFromSource(root, path, readFileSync(path, 'utf8'));
    for (const edge of scan.edges) {
      if (edge.target && edge.kind !== 'type' && !isUiSource(root, edge.target)) {
        pending.push(edge.target);
      }
    }
  }
  return [...visited].sort((left, right) =>
    projectPath(root, left).localeCompare(projectPath(root, right)),
  );
}

function isUiSource(root: string, path: string): boolean {
  const pathFromProject = projectPath(root, path);
  return pathFromProject.startsWith('src/ui/') || pathFromProject.includes('/ui/');
}

function collectProjectImportScan(root: string): {
  readonly edges: readonly SourceImportEdge[];
  readonly unsupportedDynamicImports: readonly string[];
} {
  const scans = runtimeSourceClosure(root, importSourceFiles(root)).map((path) =>
    collectImportEdgesFromSource(root, path, readFileSync(path, 'utf8')),
  );
  return {
    edges: scans
      .flatMap((scan) => scan.edges)
      .sort(
        (left, right) =>
          left.path.localeCompare(right.path) ||
          left.source.localeCompare(right.source) ||
          left.kind.localeCompare(right.kind),
      ),
    unsupportedDynamicImports: scans
      .flatMap((scan) => scan.unsupportedDynamicImports)
      .sort((left, right) => left.localeCompare(right)),
  };
}

export function collectProjectImportEdges(projectRoot: string): readonly SourceImportEdge[] {
  return collectProjectImportScan(resolve(projectRoot)).edges;
}

function importerMultiset(importers: readonly DirectImporter[]): string[] {
  return importers
    .map((importer) => `${importer.path}:${importer.kind}`)
    .sort((left, right) => left.localeCompare(right));
}

type CompositionRoot = {
  readonly path: string;
  readonly role: 'api' | 'worker';
  readonly blocksCapabilityIndex: boolean;
};

function registeredManifestPaths(root: string): Set<string> {
  const indexPath = resolve(root, 'src/capabilities/index.ts');
  if (!existsSync(indexPath)) return new Set<string>();
  const sourceFile = parseSource(readFileSync(indexPath, 'utf8'), indexPath);
  const imports = new Map<string, string>();
  const capabilityArrays: ts.ArrayLiteralExpression[] = [];
  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement)) {
      const source = textValue(statement.moduleSpecifier);
      const clause = statement.importClause;
      if (!source || !clause || clause.isTypeOnly) continue;
      const target = resolveImportTarget(root, indexPath, source);
      if (!target) continue;
      if (clause.namedBindings && ts.isNamedImports(clause.namedBindings)) {
        for (const specifier of clause.namedBindings.elements) {
          if (!specifier.isTypeOnly) imports.set(specifier.name.text, projectPath(root, target));
        }
      }
      continue;
    }
    if (
      !ts.isVariableStatement(statement) ||
      !statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword) ||
      !(statement.declarationList.flags & ts.NodeFlags.Const)
    ) {
      continue;
    }
    for (const declarator of statement.declarationList.declarations) {
      if (
        !ts.isIdentifier(declarator.name) ||
        declarator.name.text !== 'capabilities' ||
        !declarator.initializer ||
        !ts.isArrayLiteralExpression(declarator.initializer)
      ) {
        continue;
      }
      capabilityArrays.push(declarator.initializer);
    }
  }
  if (capabilityArrays.length !== 1) {
    throw new Error(`${indexPath}: exactly one exported static capabilities array is required`);
  }
  const [capabilities] = capabilityArrays;
  if (!capabilities) throw new Error(`${indexPath}: capabilities array is missing`);
  const paths = capabilities.elements.map((element) => {
    const name = ts.isIdentifier(element) ? element.text : undefined;
    const path = name ? imports.get(name) : undefined;
    if (!path || !path.endsWith('/manifest.ts')) {
      throw new Error(
        `${indexPath}: capabilities array must contain imported manifest identifiers`,
      );
    }
    return path;
  });
  return new Set(paths);
}

function manifestCompositionRoots(root: string): CompositionRoot[] {
  const roots: CompositionRoot[] = [];
  const registered = registeredManifestPaths(root);
  for (const path of sourceFiles(resolve(root, 'src/capabilities'))) {
    if (!path.endsWith('/manifest.ts') || !registered.has(projectPath(root, path))) continue;
    const sourceFile = parseSource(readFileSync(path, 'utf8'), path);
    function visit(node: ts.Node, keys: readonly string[]): void {
      if (ts.isPropertyAssignment(node)) {
        const key = ts.isIdentifier(node.name) ? node.name.text : textValue(node.name);
        if (key) visit(node.initializer, [...keys, key]);
        return;
      }
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const source = textValue(node.arguments[0]);
        const target = source ? resolveImportTarget(root, path, source) : undefined;
        const role =
          keys.join('/') === 'api/routes/load'
            ? 'api'
            : keys.join('/') === 'jobs/handlers/load'
              ? 'worker'
              : undefined;
        if (target && role) {
          roots.push({ path: projectPath(root, target), role, blocksCapabilityIndex: false });
        }
      }
      ts.forEachChild(node, (child) => visit(child, keys));
    }
    visit(sourceFile, []);
  }
  return roots;
}

function compositionRoots(root: string): CompositionRoot[] {
  const roots = manifestCompositionRoots(root);
  const app = resolve(root, 'server/app.ts');
  if (existsSync(app)) {
    roots.push({ path: 'server/app.ts', role: 'api', blocksCapabilityIndex: true });
  }
  const handlers = resolve(root, 'src/server/boss/handlers.ts');
  if (existsSync(handlers)) {
    roots.push({
      path: 'src/server/boss/handlers.ts',
      role: 'worker',
      blocksCapabilityIndex: false,
    });
  }
  return roots;
}

function runtimeCompositionPaths(root: string, edges: readonly SourceImportEdge[]): Set<string> {
  const reachable = new Map<string, Set<string>>();
  for (const edge of edges) {
    if (!edge.target || edge.kind === 'type') continue;
    const targets = reachable.get(edge.path) ?? new Set<string>();
    targets.add(projectPath(root, edge.target));
    reachable.set(edge.path, targets);
  }
  const paths = new Set<string>();
  const visited = new Set<string>();
  for (const rootEntry of compositionRoots(root)) {
    const queue = [rootEntry.path];
    while (queue.length > 0) {
      const current = queue.pop();
      if (!current || visited.has(`${rootEntry.role}:${current}`)) continue;
      visited.add(`${rootEntry.role}:${current}`);
      paths.add(current);
      for (const next of reachable.get(current) ?? []) {
        if (rootEntry.blocksCapabilityIndex && next === 'src/capabilities/index.ts') continue;
        queue.push(next);
      }
    }
  }
  return paths;
}

function runtimeRolesForTarget(
  root: string,
  edges: readonly SourceImportEdge[],
  target: string,
): string[] {
  const reachable = new Map<string, Set<string>>();
  for (const edge of edges) {
    if (!edge.target || edge.kind === 'type') continue;
    const targets = reachable.get(edge.path) ?? new Set<string>();
    targets.add(projectPath(root, edge.target));
    reachable.set(edge.path, targets);
  }
  const roles = new Set<string>();
  for (const rootEntry of compositionRoots(root)) {
    const queue = [rootEntry.path];
    const visited = new Set<string>();
    while (queue.length > 0) {
      const current = queue.shift();
      if (!current || visited.has(current)) continue;
      visited.add(current);
      if (current === projectPath(root, target)) {
        roles.add(rootEntry.role);
        break;
      }
      for (const next of reachable.get(current) ?? []) {
        if (rootEntry.blocksCapabilityIndex && next === 'src/capabilities/index.ts') continue;
        queue.push(next);
      }
    }
  }
  return [...roles].sort((left, right) => left.localeCompare(right));
}

function moduleSegment(source: string): string {
  return stripSupportedExtension(basename(source));
}

function projectPath(root: string, path: string): string {
  return relative(root, path).split(sep).join('/');
}

function findingsFor(path: string, code: string, facts: SourceFacts): ProviderWireFinding[] {
  return facts.calls.flatMap((call): ProviderWireFinding[] => {
    if (call.startsWith('imported-fetch:')) {
      const [, source, local] = call.split(':');
      const isException = IMPORTED_FETCH_EXCEPTIONS.some(
        (exception) =>
          exception.path === path && exception.source === source && exception.local === local,
      );
      return isException ? [] : [{ kind: 'unclassified-provider-fetch', call, path }];
    }
    if (call === 'memory.add' || call === 'memory.search') {
      return [{ kind: 'mem0-model-bearing-operation', call, path }];
    }
    if (facts.imports.includes('@anthropic-ai/sdk') && call === 'client.messages.create') {
      return [{ kind: 'xiaomi-vision-preflight-sdk', call, path }];
    }
    if (
      facts.imports.includes('tencentcloud-sdk-nodejs-ocr') &&
      (call === 'client.SubmitQuestionMarkAgentJob' ||
        call === 'client.DescribeQuestionMarkAgentJob')
    ) {
      return [{ kind: 'tencent-question-mark-agent-sdk', call, path }];
    }
    if (call !== 'fetch' && call !== 'fetchImpl') return [];
    if (code.includes('/embeddings')) return [{ kind: 'dashscope-embedding-fetch', call, path }];
    if (code.includes('judgeEdgeReconcile') && code.includes('/chat/completions')) {
      return [{ kind: 'glm-edge-reconcile-fetch', call, path }];
    }
    if (code.includes('judgeReconciliation') && code.includes('/chat/completions')) {
      return [{ kind: 'glm-memory-reconcile-fetch', call, path }];
    }
    if (code.includes('layout_parsing'))
      return [{ kind: 'glm-ocr-layout-parsing-fetch', call, path }];
    return [{ kind: 'unclassified-provider-fetch', call, path }];
  });
}

function checkImportedFetchExceptions(
  root: string,
  edges: readonly SourceImportEdge[],
  requireDeclaredPaths: boolean,
): ProviderLaneViolation[] {
  return IMPORTED_FETCH_EXCEPTIONS.flatMap((exception): ProviderLaneViolation[] => {
    const path = resolve(root, exception.path);
    if (!existsSync(path)) {
      return requireDeclaredPaths
        ? [{ path: exception.path, reason: 'imported fetch exception path does not exist' }]
        : [];
    }
    const facts = inspectSource(readFileSync(path, 'utf8'), path);
    const call = `imported-fetch:${exception.source}:${exception.local}`;
    const matchesImport = facts.importedFetches.some(
      (binding) => binding.source === exception.source && binding.local === exception.local,
    );
    const expectedCalls = Array.from({ length: exception.expectedCalls }, () => call);
    const observedCalls = facts.calls.filter((candidate) => candidate === call);
    const observedImporters = edges
      .filter((edge) => edge.target === path)
      .flatMap((edge) => {
        const bindings = edge.bindings ?? [];
        return bindings.length > 0
          ? bindings.map(
              (binding) =>
                `${edge.path}:${edge.kind}:${edge.source}:${binding.imported}:${binding.local}`,
            )
          : [`${edge.path}:${edge.kind}:${edge.source}:<none>:<none>`];
      })
      .sort((left, right) => left.localeCompare(right));
    const expectedImporters = exception.directImporters
      .map(
        (importer) =>
          `${importer.path}:${importer.kind}:${importer.source}:${importer.imported}:${importer.local}`,
      )
      .sort((left, right) => left.localeCompare(right));
    return matchesImport &&
      sameMultiset(observedCalls, expectedCalls) &&
      sameMultiset(observedImporters, expectedImporters)
      ? []
      : [
          {
            path: exception.path,
            reason:
              'imported fetch exception no longer matches declared import, call multiset, or importer closure',
          },
        ];
  });
}

function isWatchedProviderSdk(source: string): boolean {
  return (
    source.startsWith('@anthropic-ai/sdk') ||
    source.startsWith('@anthropic-ai/claude-agent-sdk') ||
    source.startsWith('openai') ||
    source.startsWith('mem0ai/oss') ||
    source.startsWith('tencentcloud-sdk-nodejs-ocr')
  );
}

function operatorSourceFiles(root: string): string[] {
  const scriptsRoot = resolve(root, 'scripts');
  if (!existsSync(scriptsRoot)) return [];
  return sourceFiles(scriptsRoot).filter(
    (path) => projectPath(root, path) !== 'scripts/worker.ts' && !/\.d\.[cm]?[jt]sx?$/u.test(path),
  );
}

function operatorProviderSdkImportEdges(root: string): SourceImportEdge[] {
  return operatorSourceFiles(root)
    .flatMap((path) => collectImportEdgesFromSource(root, path, readFileSync(path, 'utf8')).edges)
    .filter((edge) => edge.kind !== 'type' && isWatchedProviderSdk(edge.source));
}

function hasAgentProviderStartBinding(edge: SourceImportEdge): boolean {
  return (
    edge.source.startsWith('@anthropic-ai/claude-agent-sdk') &&
    (edge.bindings ?? []).some(
      (binding) => binding.imported === 'startup' || binding.imported === 'query',
    )
  );
}

function sdkEntryMatchesEdge(
  entry: (typeof PROVIDER_RUNTIME_SDK_IMPORTS)[number],
  edge: SourceImportEdge,
): boolean {
  if (entry.path !== edge.path || entry.source !== edge.source) return false;
  return entry.disposition === 'lane'
    ? true
    : (edge.bindings ?? []).some(
        (binding) => binding.imported === entry.imported && binding.local === entry.local,
      );
}

function staticProviderContractViolations(): ProviderLaneViolation[] {
  const violations: ProviderLaneViolation[] = [];
  const fetchKeys = new Set<string>();
  for (const entry of IMPORTED_FETCH_EXCEPTIONS) {
    const key = `${entry.path}:${entry.source}:${entry.imported}:${entry.local}`;
    if (
      fetchKeys.has(key) ||
      !entry.path.trim() ||
      !entry.source.trim() ||
      !entry.local.trim() ||
      !entry.owner.trim() ||
      !entry.purpose.trim()
    ) {
      violations.push({
        path: 'scripts/provider-lane-inventory.ts',
        reason: 'invalid imported fetch exception',
      });
    }
    fetchKeys.add(key);
  }
  const sdkKeys = new Set<string>();
  for (const entry of PROVIDER_RUNTIME_SDK_IMPORTS) {
    const key = `${entry.path}:${entry.source}`;
    if (sdkKeys.has(key) || !entry.path.trim() || !entry.source.trim()) {
      violations.push({
        path: 'scripts/provider-lane-inventory.ts',
        reason: 'invalid provider SDK runtime import',
      });
    }
    sdkKeys.add(key);
  }
  return violations;
}

function checkProviderSdkImports(
  root: string,
  edges: readonly SourceImportEdge[],
  lanes: readonly ProviderLane[],
  requireDeclaredPaths: boolean,
): ProviderLaneViolation[] {
  const operatorEdges = operatorProviderSdkImportEdges(root);
  const productionPaths = runtimeCompositionPaths(root, edges);
  for (const entry of PROVIDER_RUNTIME_SDK_IMPORTS) productionPaths.add(entry.path);
  for (const edge of operatorEdges) productionPaths.add(edge.path);
  const observed = [...edges, ...operatorEdges].filter(
    (edge) =>
      productionPaths.has(edge.path) &&
      edge.kind !== 'type' &&
      isWatchedProviderSdk(edge.source) &&
      (!edge.source.startsWith('@anthropic-ai/claude-agent-sdk') ||
        hasAgentProviderStartBinding(edge)),
  );
  const violations: ProviderLaneViolation[] = [];
  for (const edge of observed) {
    if (!PROVIDER_RUNTIME_SDK_IMPORTS.some((entry) => sdkEntryMatchesEdge(entry, edge))) {
      violations.push({
        path: edge.path,
        reason: `unlisted provider SDK runtime import: ${edge.source}`,
      });
    }
  }
  for (const entry of PROVIDER_RUNTIME_SDK_IMPORTS) {
    if (!existsSync(resolve(root, entry.path))) {
      if (requireDeclaredPaths) {
        violations.push({
          path: entry.path,
          reason: `declared provider SDK runtime import is missing: ${entry.source}`,
        });
      }
      continue;
    }
    if (entry.disposition !== 'central' && !lanes.some((lane) => lane.id === entry.laneId)) {
      violations.push({
        path: entry.path,
        reason: `provider SDK lane reference does not exist: ${entry.laneId}`,
      });
    }
    if (!observed.some((edge) => sdkEntryMatchesEdge(entry, edge))) {
      violations.push({
        path: entry.path,
        reason: `declared provider SDK runtime import is missing: ${entry.source}`,
      });
    }
  }
  return violations;
}

export function collectProviderWireFindings(projectRoot: string): ProviderWireFinding[] {
  const declaredOperatorWires = PROVIDER_LANES.filter((lane) => lane.disposition === 'exempt')
    .map((lane) => resolve(projectRoot, lane.wire.path))
    .filter((path) => existsSync(path));
  const declaredWirePaths = new Set<string>(PROVIDER_LANES.map((lane) => lane.wire.path));
  const runtimeFindings = runtimeSourceClosure(projectRoot, [
    ...backendSourceFiles(projectRoot),
    ...declaredOperatorWires,
  ]).flatMap((path) => {
    const code = readFileSync(path, 'utf8');
    return findingsFor(projectPath(projectRoot, path), code, inspectSource(code, path));
  });
  const operatorFindings = operatorSourceFiles(projectRoot).flatMap((path) => {
    const pathFromProject = projectPath(projectRoot, path);
    if (declaredWirePaths.has(pathFromProject)) return [];
    const code = readFileSync(path, 'utf8');
    if (!OPERATOR_PROVIDER_MARKERS.some((marker) => code.includes(marker))) return [];
    return findingsFor(pathFromProject, code, inspectSource(code, path));
  });
  return [...runtimeFindings, ...operatorFindings].sort(
    (left, right) =>
      left.kind.localeCompare(right.kind) ||
      left.path.localeCompare(right.path) ||
      left.call.localeCompare(right.call),
  );
}

function checkEvidence(
  root: string,
  evidence: SourceEvidence,
  role: string,
): ProviderLaneViolation | undefined {
  const path = resolve(root, evidence.path);
  if (!existsSync(path))
    return { path: evidence.path, reason: `${role} evidence path does not exist` };
  const code = readFileSync(path, 'utf8');
  const facts = inspectSource(code, path);
  const importsMatch = evidence.imports?.every((source) => facts.imports.includes(source)) ?? true;
  const callsMatch = evidence.calls?.every((call) => facts.calls.includes(call)) ?? true;
  const envReadsMatch = evidence.envReads?.every((name) => facts.envReads.includes(name)) ?? true;
  const literalsMatch =
    evidence.literals?.every((literal) => facts.literals.includes(literal)) ?? true;
  const tokensMatch = evidence.contains?.every((needle) => code.includes(needle)) ?? true;
  if (importsMatch && callsMatch && envReadsMatch && literalsMatch && tokensMatch) return undefined;
  const mismatches = [
    !importsMatch ? 'import' : undefined,
    !callsMatch ? 'call' : undefined,
    !envReadsMatch ? 'env read' : undefined,
    !literalsMatch ? 'literal' : undefined,
    !tokensMatch ? 'token' : undefined,
  ].filter((value): value is string => Boolean(value));
  return {
    path: evidence.path,
    reason: `${role} evidence no longer matches declared ${mismatches.join(', ')}`,
  };
}

function checkConfiguration(
  root: string,
  configuration: ProviderConfigurationTruth,
): ProviderLaneViolation[] {
  const entries = [
    ['configuration endpoint', configuration.endpoint.source],
    ['configuration credential', configuration.credential.source],
    ['configuration model', configuration.model.source],
  ] as const;
  return entries.flatMap((entry): ProviderLaneViolation[] => {
    const violation = checkEvidence(root, entry[1], entry[0]);
    return violation ? [violation] : [];
  });
}

function sameMultiset(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function laneForFinding(kind: ProviderWireFinding['kind']): string | undefined {
  const ids = {
    'dashscope-embedding-fetch': 'dashscope.embedding',
    'glm-edge-reconcile-fetch': 'glm.knowledge-edge-reconcile',
    'glm-memory-reconcile-fetch': 'glm.memory-reconcile',
    'glm-ocr-layout-parsing-fetch': 'glm.ocr-layout-parsing',
    'mem0-model-bearing-operation': 'mem0.event-memory',
    'xiaomi-vision-preflight-sdk': 'xiaomi.vision-preflight',
    'tencent-question-mark-agent-sdk': 'tencent.question-mark-agent',
  } as const;
  return kind === 'unclassified-provider-fetch' ? undefined : ids[kind];
}

export function auditProviderLanes(
  projectRoot: string,
  lanes: readonly ProviderLane[] = PROVIDER_LANES,
): ProviderLaneAuditResult {
  const root = resolve(projectRoot);
  const findings = collectProviderWireFindings(root);
  const importScan = collectProjectImportScan(root);
  const violations: ProviderLaneViolation[] = validateProviderLaneInventory(lanes).map(
    (reason) => ({
      path: 'scripts/provider-lane-inventory.ts',
      reason,
    }),
  );
  const requireDeclaredPaths = lanes === PROVIDER_LANES;
  violations.push(
    ...staticProviderContractViolations(),
    ...checkImportedFetchExceptions(root, importScan.edges, requireDeclaredPaths),
    ...checkProviderSdkImports(root, importScan.edges, lanes, requireDeclaredPaths),
  );
  for (const finding of findings) {
    const laneId = laneForFinding(finding.kind);
    const lane = laneId ? lanes.find((candidate) => candidate.id === laneId) : undefined;
    if (!lane || lane.wire.path !== finding.path || !lane.wire.calls.includes(finding.call)) {
      violations.push({
        path: finding.path,
        reason: `unlisted direct provider wire: ${finding.kind}`,
      });
    }
  }
  for (const lane of lanes) {
    if (lane.disposition === 'prune') continue;
    violations.push(...checkConfiguration(root, lane.configuration));
    for (const evidence of lane.attemptSemantics.evidence) {
      const violation = checkEvidence(root, evidence, 'attempt semantics');
      if (violation) violations.push(violation);
    }
    if (lane.exemption) {
      const violation = checkEvidence(root, lane.exemption.evidence, 'exemption');
      if (violation) violations.push(violation);
    }
    const observedCalls = findings
      .filter(
        (finding) => laneForFinding(finding.kind) === lane.id && finding.path === lane.wire.path,
      )
      .map((finding) => finding.call)
      .sort((left, right) => left.localeCompare(right));
    const expectedCalls = [...lane.wire.calls].sort((left, right) => left.localeCompare(right));
    if (!sameMultiset(observedCalls, expectedCalls)) {
      violations.push({
        path: lane.wire.path,
        reason: `wire call count drift: expected ${expectedCalls.join(', ')}; observed ${observedCalls.join(', ')}`,
      });
    }
    const wirePath = resolve(root, lane.wire.path);
    const observedImporters = importerMultiset(
      importScan.edges
        .filter((edge) => edge.target === wirePath)
        .map((edge) => ({ path: edge.path, kind: edge.kind })),
    );
    const expectedImporters = importerMultiset(lane.directImporters);
    if (!sameMultiset(observedImporters, expectedImporters)) {
      violations.push({
        path: lane.wire.path,
        reason: `direct importer closure drift: expected ${expectedImporters.join(', ')}; observed ${observedImporters.join(', ')}`,
      });
    }
    const observedRoles =
      lane.disposition === 'exempt'
        ? ['operator']
        : runtimeRolesForTarget(root, importScan.edges, wirePath);
    const expectedRoles = [...lane.roles].sort((left, right) => left.localeCompare(right));
    if (!sameMultiset(observedRoles, expectedRoles)) {
      violations.push({
        path: lane.wire.path,
        reason: `runtime role closure drift: expected ${expectedRoles.join(', ')}; observed ${observedRoles.join(', ')}`,
      });
    }
    for (const [role, evidence] of [
      ['wire', lane.wire],
      ['evidence hook', lane.evidence],
      ...lane.callers.map((caller) => ['caller', caller] as const),
    ] as const) {
      const violation = checkEvidence(root, evidence, role);
      if (violation) violations.push(violation);
    }
  }

  for (const path of importScan.unsupportedDynamicImports) {
    violations.push({
      path,
      reason: 'unsupported dynamic import prevents direct importer closure validation',
    });
  }

  const prunedImportNames = new Set(
    PRUNED_MISCONCEPTION_MODULES.map((path) => moduleSegment(path)),
  );
  for (const module of PRUNED_MISCONCEPTION_MODULES) {
    if (existsSync(resolve(root, module))) {
      violations.push({ path: module, reason: 'pruned module was reintroduced' });
    }
  }
  for (const edge of importScan.edges) {
    if (prunedImportNames.has(moduleSegment(edge.source))) {
      violations.push({
        path: edge.path,
        reason: 'pruned misconception reconcile module is imported',
      });
    }
  }

  const sortedViolations = violations.sort(
    (left, right) => left.path.localeCompare(right.path) || left.reason.localeCompare(right.reason),
  );
  return { ok: sortedViolations.length === 0, findings, violations: sortedViolations };
}

function readProjectRoot(args: readonly string[]): string {
  const index = args.indexOf('--root');
  const root = index >= 0 ? args[index + 1] : undefined;
  if (!root) throw new Error('usage: tsx scripts/audit-provider-lanes.ts --root <project-root>');
  return root;
}

function isCliEntry(): boolean {
  const entry = process.argv[1];
  return Boolean(entry) && import.meta.url === pathToFileURL(entry).href;
}

if (isCliEntry()) {
  const result = auditProviderLanes(readProjectRoot(process.argv.slice(2)));
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) process.exitCode = 1;
}
