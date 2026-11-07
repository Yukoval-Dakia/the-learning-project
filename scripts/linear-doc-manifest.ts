// Enumerates tracked repo Markdown for Linear document migration. The former
// documentation tree and PLANNING.md are no longer tracked; their copy lives in the
// external repo-docs snapshot and is intentionally absent from this manifest.
import { execFileSync } from 'node:child_process';

type ManifestRow = {
  repoPath: string;
  role: string;
  freshness: string;
  lastSourceCommit: string;
  verifiedAgainst: string;
  linearDestination: string;
  migrationAction: string;
  notes: string;
};

function git(args: string[]): string {
  return execFileSync('git', args, { encoding: 'utf8' }).trim();
}

function trackedMarkdownFiles(): string[] {
  return git(['ls-files', '--cached', '--others', '--exclude-standard', '*.md', '*.mdx'])
    .split('\n')
    .filter(Boolean)
    .sort();
}

function lastSourceCommit(path: string): string {
  try {
    const value = git(['log', '-1', '--format=%cs %h', '--', path]);
    return value || 'untracked';
  } catch {
    return 'untracked';
  }
}

function classify(path: string): Omit<ManifestRow, 'repoPath' | 'lastSourceCommit'> {
  if (path === 'README.md') {
    return {
      role: 'current',
      freshness: 'current',
      verifiedAgainst: 'package.json + CLAUDE.md + app/ + src/',
      linearDestination: 'Doc Catalog - Repo Linear Manifest',
      migrationAction: 'catalog-only',
      notes:
        'Current project entrance after 2026-05-23 refresh; link from Linear catalog unless a full mirror is explicitly needed.',
    };
  }

  if (path === 'CLAUDE.md' || path === 'AGENTS.md' || path === 'CONTEXT.md') {
    return {
      role: 'current',
      freshness: 'current',
      verifiedAgainst: 'agent instructions + current repo layout',
      linearDestination: 'Doc Catalog - Repo Linear Manifest',
      migrationAction: 'catalog-only',
      notes: 'Repo-local agent/operator guidance remains in repo.',
    };
  }

  if (path.startsWith('src/')) {
    return {
      role: 'code-adjacent-readme',
      freshness: 'needs-review',
      verifiedAgainst: 'adjacent source files before reuse',
      linearDestination: 'Doc Catalog - Repo Linear Manifest',
      migrationAction: 'catalog-only',
      notes: 'Keep near code; Linear links only.',
    };
  }

  if (path.startsWith('.claude/skills/')) {
    return {
      role: 'agent-skill',
      freshness: 'current',
      verifiedAgainst: 'agent runtime behavior',
      linearDestination: 'Doc Catalog - Repo Linear Manifest',
      migrationAction: 'catalog-only',
      notes: 'Skill instructions remain executable repo config.',
    };
  }

  return {
    role: 'reference',
    freshness: 'needs-review',
    verifiedAgainst: 'manual freshness pass',
    linearDestination: 'Doc Catalog - Repo Linear Manifest',
    migrationAction: 'catalog-only',
    notes: 'Fallback mapping; verify before migration.',
  };
}

function rowFor(path: string): ManifestRow {
  return {
    repoPath: path,
    lastSourceCommit: lastSourceCommit(path),
    ...classify(path),
  };
}

const files = trackedMarkdownFiles();
const head = git(['rev-parse', '--short', 'HEAD']);
const rows = files.map(rowFor);

console.log('# Linear Document Manifest\n');
console.log(
  `Generated from \`git ls-files --cached --others --exclude-standard '*.md' '*.mdx'\` at HEAD \`${head}\`.`,
);
console.log(`Markdown files covered: ${rows.length}.\n`);
console.log(
  '| repo_path | role | freshness | last_source_commit | verified_against | linear_destination | migration_action | notes |',
);
console.log('|---|---|---|---|---|---|---|---|');
for (const row of rows) {
  console.log(
    `| \`${row.repoPath}\` | ${row.role} | ${row.freshness} | ${row.lastSourceCommit} | ${row.verifiedAgainst} | ${row.linearDestination} | ${row.migrationAction} | ${row.notes} |`,
  );
}
