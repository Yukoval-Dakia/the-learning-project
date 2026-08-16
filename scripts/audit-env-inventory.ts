import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';

const SOURCE_FILE = /\.(?:ts|tsx|mts|cts)$/u;
const TEST_FILE = /(?:\.(?:test|spec)|\.unit|\.db)\.(?:ts|tsx|mts|cts)$/u;
const EXCLUDED_DIRECTORIES = new Set(['.git', '.cache', 'dist', 'node_modules']);
const ENV_KEY = /^[A-Z][A-Z0-9_]*$/u;

function sourceFiles(root: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root).sort((left, right) => left.localeCompare(right))) {
    const path = join(root, entry);
    const stats = lstatSync(path);
    if (stats.isSymbolicLink()) throw new Error(`${path}: symbolic link found in env inventory`);
    if (stats.isDirectory() && !EXCLUDED_DIRECTORIES.has(entry)) {
      files.push(...sourceFiles(path));
    } else if (stats.isFile() && SOURCE_FILE.test(entry) && !TEST_FILE.test(entry)) {
      files.push(path);
    }
  }
  return files;
}

function isProcessEnv(node: ts.Node): boolean {
  return (
    ts.isPropertyAccessExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === 'process' &&
    node.name.text === 'env'
  );
}

function isProcessEnvType(node: ts.TypeNode | undefined): boolean {
  if (!node || !ts.isTypeReferenceNode(node)) return false;
  const name = node.typeName;
  return (
    ts.isQualifiedName(name) &&
    ts.isIdentifier(name.left) &&
    name.left.text === 'NodeJS' &&
    name.right.text === 'ProcessEnv'
  );
}

function stringValues(
  node: ts.Node | undefined,
  bindings: ReadonlyMap<string, ts.Node>,
): Set<string> {
  if (!node) return new Set();
  if (ts.isStringLiteralLike(node))
    return ENV_KEY.test(node.text) ? new Set([node.text]) : new Set();
  if (ts.isIdentifier(node)) return stringValues(bindings.get(node.text), bindings);
  if (ts.isParenthesizedExpression(node)) return stringValues(node.expression, bindings);
  if (ts.isAsExpression(node) || ts.isSatisfiesExpression(node)) {
    return stringValues(node.expression, bindings);
  }
  if (ts.isObjectLiteralExpression(node)) {
    return new Set(
      node.properties.flatMap((property) =>
        ts.isPropertyAssignment(property) ? [...stringValues(property.initializer, bindings)] : [],
      ),
    );
  }
  if (ts.isArrayLiteralExpression(node)) {
    return new Set(node.elements.flatMap((element) => [...stringValues(element, bindings)]));
  }
  if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
    return stringValues(bindings.get(node.expression.getText()), bindings);
  }
  return new Set();
}

export type EnvInventory = ReadonlyMap<string, ReadonlySet<string>>;

export function collectEnvInventory(projectRoot: string): EnvInventory {
  const inventory = new Map<string, Set<string>>();
  const projectFiles = ['src', 'server', 'scripts'].flatMap((sourceRoot) =>
    sourceFiles(join(projectRoot, sourceRoot)),
  );
  const globalBindings = new Map<string, ts.Node>();
  for (const filename of projectFiles) {
    const source = ts.createSourceFile(
      filename,
      readFileSync(filename, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
      filename.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    function collectGlobalBindings(node: ts.Node): void {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
        const values = stringValues(node.initializer, globalBindings);
        if (values.size > 0) globalBindings.set(node.name.text, node.initializer);
      }
      ts.forEachChild(node, collectGlobalBindings);
    }
    collectGlobalBindings(source);
  }

  for (const filename of projectFiles) {
    const source = ts.createSourceFile(
      filename,
      readFileSync(filename, 'utf8'),
      ts.ScriptTarget.Latest,
      true,
      filename.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
    );
    const bindings = new Map(globalBindings);
    const envAliases = new Set<string>();

    function collectBindings(node: ts.Node): void {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
        bindings.set(node.name.text, node.initializer);
        bindings.set(node.name.getText(source), node.initializer);
        if (isProcessEnv(node.initializer) || isProcessEnvType(node.type))
          envAliases.add(node.name.text);
      }
      if (ts.isParameter(node) && ts.isIdentifier(node.name)) {
        if (isProcessEnvType(node.type) || (node.initializer && isProcessEnv(node.initializer))) {
          envAliases.add(node.name.text);
        }
      }
      ts.forEachChild(node, collectBindings);
    }
    collectBindings(source);

    const keys = new Set<string>();
    function visit(node: ts.Node): void {
      if (ts.isPropertyAccessExpression(node)) {
        if (isProcessEnv(node.expression)) keys.add(node.name.text);
        if (ts.isIdentifier(node.expression) && envAliases.has(node.expression.text)) {
          keys.add(node.name.text);
        }
      }
      if (ts.isElementAccessExpression(node)) {
        const expression = node.expression;
        const readsEnv =
          isProcessEnv(expression) ||
          (ts.isIdentifier(expression) && envAliases.has(expression.text));
        if (readsEnv) {
          for (const key of stringValues(node.argumentExpression, bindings)) keys.add(key);
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
    if (keys.size > 0) inventory.set(relative(projectRoot, filename), keys);
  }
  return inventory;
}

export function missingEnvSchemaKeys(
  inventory: EnvInventory,
  schemaKeys: ReadonlySet<string>,
): readonly string[] {
  return [...inventory.entries()]
    .flatMap(([file, keys]) => [...keys].map((key) => ({ file, key })))
    .filter(({ key }) => !schemaKeys.has(key))
    .map(({ file, key }) => `${key} (${file})`)
    .sort((left, right) => left.localeCompare(right));
}
