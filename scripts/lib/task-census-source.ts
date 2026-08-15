import { readdirSync } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import {
  collectRunnerAliases,
  isRunnerCall,
  isRunnerInfrastructureDelegation,
  resolveTaskKinds,
} from './task-census-static';

const SOURCE_DIRECTORIES = ['src', 'scripts'] as const;

export type CallerEvidence = {
  readonly kind: string;
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly callee: string;
};

export type UnresolvedCaller = Omit<CallerEvidence, 'kind'> & {
  readonly expression: string;
};

export type SourceScanResult = {
  readonly callersByKind: Readonly<Record<string, readonly CallerEvidence[]>>;
  readonly unresolvedCallers: readonly UnresolvedCaller[];
};

function isProductionSource(relativePath: string): boolean {
  const normalized = relativePath.replaceAll(path.sep, '/');
  return (
    /\.(?:ts|tsx)$/.test(normalized) &&
    !normalized.startsWith('scripts/dev/') &&
    !/\.(?:test|spec|fixture|generated)\.(?:ts|tsx)$/.test(normalized) &&
    !normalized.endsWith('.d.ts') &&
    !normalized.includes('/fixtures/') &&
    !normalized.includes('/generated/') &&
    !normalized.includes('/__fixtures__/')
  );
}

function collectSourceFiles(sourceRoot: string): readonly string[] {
  const files: string[] = [];
  const visit = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(entryPath);
      } else if (isProductionSource(path.relative(sourceRoot, entryPath))) {
        files.push(entryPath);
      }
    }
  };
  for (const sourceDirectory of SOURCE_DIRECTORIES) {
    try {
      visit(path.join(sourceRoot, sourceDirectory));
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
        continue;
      }
      throw error;
    }
  }
  return files;
}

function locationFor(
  sourceRoot: string,
  sourceFile: ts.SourceFile,
  call: ts.CallExpression,
): Omit<CallerEvidence, 'kind'> {
  const point = sourceFile.getLineAndCharacterOfPosition(call.getStart(sourceFile));
  return {
    file: path.relative(sourceRoot, sourceFile.fileName).replaceAll(path.sep, '/'),
    line: point.line + 1,
    column: point.character + 1,
    callee: call.expression.getText(sourceFile),
  };
}

export function scanTaskCallers(sourceRoot: string): SourceScanResult {
  const sourceFiles = collectSourceFiles(sourceRoot);
  const program = ts.createProgram(sourceFiles, { noResolve: true, skipLibCheck: true });
  const checker = program.getTypeChecker();
  const callersByKind: Record<string, CallerEvidence[]> = {};
  const unresolvedCallers: UnresolvedCaller[] = [];

  for (const filePath of sourceFiles) {
    const sourceFile = program.getSourceFile(filePath);
    if (sourceFile === undefined) {
      continue;
    }
    const aliases = collectRunnerAliases(sourceFile);
    const relativePath = path.relative(sourceRoot, filePath).replaceAll(path.sep, '/');
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && isRunnerCall(node, aliases)) {
        const firstArgument = node.arguments[0];
        if (
          firstArgument !== undefined &&
          !isRunnerInfrastructureDelegation(relativePath, firstArgument, checker, aliases)
        ) {
          const location = locationFor(sourceRoot, sourceFile, node);
          const kinds = resolveTaskKinds(firstArgument, checker);
          if (kinds === undefined) {
            unresolvedCallers.push({ ...location, expression: firstArgument.getText(sourceFile) });
          } else {
            for (const kind of kinds) {
              const callers = callersByKind[kind] ?? [];
              callers.push({ kind, ...location });
              callersByKind[kind] = callers;
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return { callersByKind, unresolvedCallers };
}
