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
  if (path === 'docs/agents/linear-doc-migration.md') {
    return {
      role: 'current',
      freshness: 'current',
      verifiedAgainst: 'git ls-files + Linear Project Ops',
      linearDestination: 'Doc Catalog - Repo Linear Manifest',
      migrationAction: 'full-doc',
      notes: 'Canonical repo-to-Linear mapping rules.',
    };
  }

  if (path === 'docs/superpowers/status.md') {
    return {
      role: 'current',
      freshness: 'current',
      verifiedAgainst: 'HEAD + git log + code facts',
      linearDestination: 'Current Status Snapshot',
      migrationAction: 'full-doc',
      notes: 'Primary current status source for Linear.',
    };
  }

  if (path === 'docs/planning/v0.3-generalized-ai-learning-framework.md') {
    return {
      role: 'strategy',
      freshness: 'current',
      verifiedAgainst: 'HEAD + status.md + Linear projects',
      linearDestination: 'Roadmap Execution Map',
      migrationAction: 'summarized-doc',
      notes: 'Strategy stays in repo; Linear gets execution map.',
    };
  }

  if (path === 'PLANNING.md') {
    return {
      role: 'historical',
      freshness: 'historical-reference',
      verifiedAgainst: 'self-labelled superseded by v0.3',
      linearDestination: 'Historical References Index',
      migrationAction: 'catalog-only',
      notes: 'Do not use as active roadmap.',
    };
  }

  if (path === 'RESUME.md') {
    return {
      role: 'scratch',
      freshness: 'scratch-do-not-migrate',
      verifiedAgainst: 'git log + status.md',
      linearDestination: 'issue extraction only',
      migrationAction: 'issue-extraction',
      notes: 'Extract still-valid leftovers into Linear issues.',
    };
  }

  if (path === 'README.md') {
    return {
      role: 'current',
      freshness: 'needs-refresh',
      verifiedAgainst: 'package.json + CLAUDE.md stack note',
      linearDestination: 'Doc Catalog - Repo Linear Manifest',
      migrationAction: 'catalog-only',
      notes: 'Known stale project door; refresh before mirroring.',
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

  if (path.startsWith('docs/agents/')) {
    return {
      role: 'current',
      freshness: 'current',
      verifiedAgainst: 'Linear workspace + repo instructions',
      linearDestination: 'Doc Catalog - Repo Linear Manifest',
      migrationAction: 'full-doc',
      notes: 'Operational docs worth mirroring after verification.',
    };
  }

  if (path.startsWith('docs/adr/')) {
    return {
      role: 'adr',
      freshness: 'historical-reference',
      verifiedAgainst: 'ADR chain + current status references',
      linearDestination: 'Historical References Index',
      migrationAction: 'catalog-only',
      notes: 'Keep ADR text in repo; Linear links to it.',
    };
  }

  if (path.startsWith('docs/audit/')) {
    return {
      role: 'audit',
      freshness: 'historical-reference',
      verifiedAgainst: 'audit date + git commit',
      linearDestination: 'Historical References Index',
      migrationAction: 'catalog-only',
      notes: 'Evidence artifact; do not rewrite in Linear.',
    };
  }

  if (
    path.startsWith('docs/superpowers/plans/') ||
    path.startsWith('docs/superpowers/specs/') ||
    path.startsWith('docs/superpowers/brainstorms/') ||
    path.startsWith('docs/superpowers/audits/')
  ) {
    return {
      role: 'implementation-plan',
      freshness: path.includes('2026-05-23-foundation-closeout-p0-physics-profile')
        ? 'current-reference'
        : 'historical-reference',
      verifiedAgainst: 'git log + status.md',
      linearDestination: 'Historical References Index',
      migrationAction: 'catalog-only',
      notes: 'Implementation evidence; active status is summarized elsewhere.',
    };
  }

  if (path.startsWith('docs/design/')) {
    return {
      role: 'design-reference',
      freshness: 'historical-reference',
      verifiedAgainst: 'design bundle date + current UI code before reuse',
      linearDestination: 'Historical References Index',
      migrationAction: 'catalog-only',
      notes: 'Reference only unless a new design pass refreshes it.',
    };
  }

  if (path.startsWith('docs/modules/')) {
    return {
      role: 'module-doc',
      freshness: 'needs-review',
      verifiedAgainst: 'module code + schema before migration',
      linearDestination: 'Historical References Index',
      migrationAction: 'catalog-only',
      notes: 'Review per module before making any Linear current doc.',
    };
  }

  if (path.startsWith('docs/discussion/')) {
    return {
      role: 'discussion',
      freshness: 'historical-reference',
      verifiedAgainst: 'ADR-0014 summary',
      linearDestination: 'Historical References Index',
      migrationAction: 'catalog-only',
      notes: 'Consensus evidence; Linear gets index links.',
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
