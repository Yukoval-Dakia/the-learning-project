import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const LANE_NAMES = ['static', 'unit', 'db', 'migration', 'build', 'usability'];

const emptyLanes = () => Object.fromEntries(LANE_NAMES.map((lane) => [lane, false]));
const fullLanes = () => Object.fromEntries(LANE_NAMES.map((lane) => [lane, true]));

function normalizePath(file) {
  return file.replaceAll('\\', '/').replace(/^\.\/+/, '');
}

function isDocsOnly(file) {
  if (file.startsWith('docs/') || file.startsWith('.remember/')) return true;
  if (!file.includes('/') && file.endsWith('.md')) return true;
  if (file.startsWith('.agents/') || file.startsWith('.claude/')) return file.endsWith('.md');
  return /\/(?:AGENTS|CLAUDE|CONTEXT|README)\.md$/.test(file);
}

function isTestFile(file) {
  return /\.test\.tsx?$/.test(file);
}

function isMigrationSmokeTest(file) {
  return file === 'tests/integration/migration-smoke.test.ts';
}

function isDbConventionTest(file) {
  return /\.db\.test\.tsx?$/.test(file);
}

function isUnitConventionTest(file) {
  if (/\.unit\.test\.tsx?$/.test(file)) return true;
  if (file.startsWith('scripts/') && isTestFile(file)) return true;
  if (file.startsWith('src/__tests__/') && isTestFile(file)) return true;
  if (file.startsWith('src/ai/') && isTestFile(file)) return true;
  if (file.startsWith('src/core/') && isTestFile(file)) return true;
  if (file.startsWith('src/ui/') && isTestFile(file)) return true;
  if (file.startsWith('src/server/ai/judges/') && isTestFile(file)) return true;
  if (/^tests\/(?:core|schema|subjects)\//.test(file) && isTestFile(file)) return true;
  return false;
}

function globalTriggerReason(file) {
  if (file.startsWith('.github/')) return 'github-workflow';
  if (file.startsWith('drizzle/')) return 'migration';
  if (file.startsWith('src/kernel/')) return 'kernel';
  if (file.startsWith('src/core/')) return 'core';
  if (file.startsWith('src/db/')) return 'db-foundation';
  if (file === 'src/capabilities/index.ts') return 'capability-composition';
  if (/^src\/capabilities\/[^/]+\/manifest\.ts$/.test(file)) return 'capability-manifest';
  if (
    [
      'package.json',
      'pnpm-lock.yaml',
      'pnpm-workspace.yaml',
      '.node-version',
      'tsconfig.json',
      'biome.json',
      'server/app.ts',
      'tests/global-setup.ts',
      'tests/setup.db-fork.ts',
      'tests/db-fork-constants.ts',
      'tests/helpers/db.ts',
      'scripts/migrate.ts',
      'scripts/worker.ts',
    ].includes(file)
  ) {
    return 'global-config-or-runtime';
  }
  if (/^(vitest|drizzle|playwright)\..*\.ts$/.test(file)) return 'test-or-build-config';
  if (/^docker-compose(?:\.[^.]+)?\.yml$/.test(file) || file === 'Dockerfile') {
    return 'runtime-image';
  }
  if (file.startsWith('scripts/ci/')) return 'ci-selector';
  return undefined;
}

function filePlan(file) {
  if (isDocsOnly(file)) return { lanes: emptyLanes(), unitSelection: 'skip', reason: 'docs' };

  if (file.startsWith('.agents/') || file.startsWith('.claude/')) {
    return {
      lanes: { ...emptyLanes(), static: true },
      unitSelection: 'skip',
      reason: 'agent-tooling',
    };
  }

  // A direct test edit is classified before its production directory. This lets
  // a conventional test-only change avoid unrelated runtime lanes.
  if (isMigrationSmokeTest(file)) {
    return {
      lanes: { ...emptyLanes(), static: true, migration: true },
      unitSelection: 'skip',
      reason: 'migration-test',
    };
  }
  if (isDbConventionTest(file)) {
    return {
      lanes: { ...emptyLanes(), static: true, db: true },
      unitSelection: 'skip',
      reason: 'db-test',
    };
  }
  if (isUnitConventionTest(file)) {
    return {
      lanes: { ...emptyLanes(), static: true, unit: true },
      unitSelection: 'affected',
      reason: 'unit-test',
    };
  }
  // allTestInclude is broader than fastTestInclude, and the latter contains
  // explicit plain-named allowlist entries that cannot be inferred from the
  // filename alone. Run both partitions for an otherwise ambiguous direct test
  // edit so the test executes whichever config owns it.
  if (isTestFile(file)) {
    return {
      lanes: { ...emptyLanes(), static: true, unit: true, db: true },
      unitSelection: 'affected',
      reason: 'ambiguous-test-partition',
    };
  }

  const trigger = globalTriggerReason(file);
  if (trigger) {
    return { lanes: fullLanes(), unitSelection: 'full', reason: `full:${trigger}` };
  }

  if (
    file.startsWith('web/') ||
    file.startsWith('src/ui/') ||
    file.startsWith('public/') ||
    /^src\/capabilities\/[^/]+\/ui\//.test(file)
  ) {
    return {
      lanes: {
        ...emptyLanes(),
        static: true,
        unit: true,
        build: true,
        usability: true,
      },
      unitSelection: 'affected',
      reason: 'ui',
    };
  }

  if (file.startsWith('server/')) {
    return {
      lanes: {
        ...emptyLanes(),
        static: true,
        unit: true,
        db: true,
        build: true,
        usability: true,
      },
      unitSelection: 'affected',
      reason: 'server-composition',
    };
  }

  if (
    file.startsWith('src/server/') ||
    file.startsWith('src/ai/') ||
    /^src\/capabilities\/[^/]+\/(?:api|server|jobs)\//.test(file) ||
    /^src\/capabilities\/[^/]+\/public\.ts$/.test(file)
  ) {
    return {
      lanes: {
        ...emptyLanes(),
        static: true,
        unit: true,
        db: true,
        build: true,
      },
      unitSelection: 'affected',
      reason: 'server',
    };
  }

  if (file.startsWith('src/subjects/')) {
    return {
      lanes: {
        ...emptyLanes(),
        static: true,
        unit: true,
        db: true,
        build: true,
        usability: true,
      },
      unitSelection: 'affected',
      reason: 'subject-bundle',
    };
  }

  if (
    file.startsWith('scripts/audit-') ||
    file.startsWith('scripts/judge-') ||
    file.startsWith('scripts/lib/')
  ) {
    return {
      lanes: { ...emptyLanes(), static: true, unit: true },
      unitSelection: 'affected',
      reason: 'audit-tooling',
    };
  }

  if (file.startsWith('tools/api-codegen/')) {
    return {
      lanes: { ...emptyLanes(), static: true, unit: true, build: true },
      unitSelection: 'affected',
      reason: 'api-codegen',
    };
  }

  return {
    lanes: fullLanes(),
    unitSelection: 'full',
    reason: `unclassified:${file}`,
  };
}

export function classifyChangedFiles(inputFiles, options = {}) {
  const files = [...new Set(inputFiles.map(normalizePath).filter(Boolean))].sort((a, b) =>
    a.localeCompare(b),
  );
  if (options.forceFullReason) {
    return {
      schema_version: 1,
      code_changed: true,
      changed_files: files,
      lanes: fullLanes(),
      unit_selection: 'full',
      reasons: [options.forceFullReason],
    };
  }

  const lanes = emptyLanes();
  const reasons = new Set();
  let unitSelection = 'skip';
  for (const file of files) {
    const planned = filePlan(file);
    for (const lane of LANE_NAMES) lanes[lane] ||= planned.lanes[lane];
    if (planned.unitSelection === 'full') unitSelection = 'full';
    else if (planned.unitSelection === 'affected' && unitSelection === 'skip') {
      unitSelection = 'affected';
    }
    if (planned.reason !== 'docs') reasons.add(planned.reason);
  }

  const codeChanged = Object.values(lanes).some(Boolean);
  if (!lanes.unit) unitSelection = 'skip';
  return {
    schema_version: 1,
    code_changed: codeChanged,
    changed_files: files,
    lanes,
    unit_selection: unitSelection,
    reasons: [...reasons].sort((a, b) => a.localeCompare(b)),
  };
}

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function isSafeGitSha(value) {
  return /^[0-9a-f]{7,64}$/i.test(value);
}

export function parseNulDelimitedPaths(output) {
  const decoded = Buffer.isBuffer(output) ? output.toString('utf8') : String(output);
  return decoded.split('\0').filter(Boolean).map(normalizePath);
}

export function readGitChangedFiles(mergeBase, head = 'HEAD', root = process.cwd()) {
  const output = execFileSync(
    'git',
    ['diff', '--name-only', '--no-renames', '-z', mergeBase, head, '--'],
    {
      cwd: root,
      encoding: 'buffer',
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  return parseNulDelimitedPaths(output);
}

function computePlanFromGit() {
  if (process.env.CI_EVENT_NAME === 'push') {
    return {
      plan: classifyChangedFiles([], { forceFullReason: 'main-push-canary' }),
      mergeBase: process.env.BASE_SHA || '',
    };
  }

  const base = process.env.BASE_SHA?.trim();
  if (!base || /^0+$/.test(base) || !isSafeGitSha(base)) {
    return {
      plan: classifyChangedFiles([], {
        forceFullReason: base ? 'base-invalid' : 'base-unknown',
      }),
      mergeBase: '',
    };
  }

  try {
    const mergeBase = git(['merge-base', base, 'HEAD']);
    return {
      plan: classifyChangedFiles(readGitChangedFiles(mergeBase)),
      mergeBase,
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message.split('\n')[0] : String(error);
    return {
      plan: classifyChangedFiles([], { forceFullReason: `diff-failed:${detail}` }),
      mergeBase: '',
    };
  }
}

function appendOutput(key, value) {
  const output = process.env.GITHUB_OUTPUT;
  if (!output) return;
  appendFileSync(output, `${key}=${String(value)}\n`);
}

function markdownText(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('`', '&#96;')
    .replaceAll('\r', '\\r')
    .replaceAll('\n', '\\n');
}

function writeSummary(plan, mergeBase) {
  const summary = process.env.GITHUB_STEP_SUMMARY;
  if (!summary) return;
  const displayedFiles = plan.changed_files.slice(0, 200).map(markdownText);
  if (plan.changed_files.length > displayedFiles.length) {
    displayedFiles.push(`... ${plan.changed_files.length - displayedFiles.length} more`);
  }
  const lines = [
    '## CI gate plan',
    '',
    `- merge base: \`${markdownText(mergeBase || 'unavailable')}\``,
    `- unit selector: \`${plan.unit_selection}\``,
    `- reasons: ${plan.reasons.length ? plan.reasons.map((reason) => `\`${markdownText(reason)}\``).join(', ') : 'docs-only / empty diff'}`,
    '',
    '| lane | run |',
    '| --- | --- |',
    ...LANE_NAMES.map((lane) => `| ${lane} | ${plan.lanes[lane] ? 'yes' : 'skip'} |`),
    '',
    '<details><summary>Changed files</summary>',
    '',
    '```text',
    ...(displayedFiles.length ? displayedFiles : ['(none or unavailable)']),
    '```',
    '</details>',
    '',
  ];
  try {
    appendFileSync(summary, `${lines.join('\n')}\n`);
  } catch (error) {
    console.error(
      '[gate-plan] summary write failed:',
      error instanceof Error ? error.message : error,
    );
  }
}

function main() {
  const { plan, mergeBase } = computePlanFromGit();
  appendOutput('code_changed', plan.code_changed);
  for (const lane of LANE_NAMES) appendOutput(`${lane}_changed`, plan.lanes[lane]);
  appendOutput('unit_selection', plan.unit_selection);
  appendOutput('merge_base', mergeBase);
  appendOutput('plan_json', JSON.stringify(plan));
  writeSummary(plan, mergeBase);
  console.log(JSON.stringify({ ...plan, merge_base: mergeBase }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
