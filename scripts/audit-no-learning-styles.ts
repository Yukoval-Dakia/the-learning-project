import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeSource } from './lib/ts-tokenize';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

export const NO_STYLE_SCAN_ROOTS = ['src', 'server'] as const;

const EXCLUDED_DIRS = new Set(['node_modules', 'dist', '.git']);

const BANNED: ReadonlyArray<{ label: string; pattern: RegExp }> = [
  { label: 'VAK/VARK taxonomy', pattern: /\b(?:VAK|VARK)\b/i },
  {
    label: 'modality learner type',
    pattern: /\b(?:visual|auditory|aural|kinesthetic|read[ /-]write)\s+learners?\b/i,
  },
  {
    label: 'Chinese modality learner type',
    pattern: /(?:视觉|听觉|动觉|读写)型(?:的)?学习者/,
  },
  {
    label: 'learning-style personalization',
    pattern: /\blearning[ _-]?styles?\b/i,
  },
  {
    label: 'Chinese learning-style personalization',
    pattern: /学习风格|按.{0,12}风格.{0,12}(?:教学|讲解|出题)/,
  },
];

export interface NoLearningStylesViolation {
  file: string;
  line: number;
  label: string;
  value: string;
}

function codeLines(text: string): Array<{ line: number; value: string }> {
  const { commentMask } = analyzeSource(text);
  const rows: Array<{ line: number; value: string }> = [];
  let offset = 0;
  for (const [index, rawLine] of text.split('\n').entries()) {
    let value = '';
    for (let cursor = 0; cursor < rawLine.length; cursor += 1) {
      if (commentMask[offset + cursor] === 0) value += rawLine[cursor];
    }
    const trimmed = value.trim();
    if (trimmed) rows.push({ line: index + 1, value: trimmed });
    offset += rawLine.length + 1;
  }
  return rows;
}

export function scanNoLearningStyles(file: string, text: string): NoLearningStylesViolation[] {
  const violations: NoLearningStylesViolation[] = [];
  for (const row of codeLines(text)) {
    for (const rule of BANNED) {
      if (rule.pattern.test(row.value)) {
        violations.push({ file, line: row.line, label: rule.label, value: row.value });
      }
    }
  }
  return violations;
}

function walkProductionFiles(root: string, out: string[] = []): string[] {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (EXCLUDED_DIRS.has(entry.name)) continue;
    const absolute = join(root, entry.name);
    if (entry.isDirectory()) {
      walkProductionFiles(absolute, out);
      continue;
    }
    if (
      entry.isFile() &&
      (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx')) &&
      !entry.name.endsWith('.test.ts') &&
      !entry.name.endsWith('.test.tsx') &&
      !entry.name.endsWith('.d.ts')
    ) {
      out.push(absolute);
    }
  }
  return out;
}

export function auditNoLearningStyles(roots: readonly string[] = NO_STYLE_SCAN_ROOTS): {
  filesScanned: number;
  violations: NoLearningStylesViolation[];
} {
  const files = roots.flatMap((root) => walkProductionFiles(join(REPO_ROOT, root))).sort();
  const violations = files.flatMap((absolute) =>
    scanNoLearningStyles(relative(REPO_ROOT, absolute), readFileSync(absolute, 'utf8')),
  );
  return { filesScanned: files.length, violations };
}

function main(): void {
  const result = auditNoLearningStyles();
  if (result.violations.length > 0) {
    console.error('No-learning-styles audit failed:');
    for (const violation of result.violations) {
      console.error(
        `  ${violation.file}:${violation.line} [${violation.label}] ${JSON.stringify(violation.value)}`,
      );
    }
    process.exitCode = 1;
    return;
  }
  console.log(`No-learning-styles audit passed (${result.filesScanned} production files).`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
