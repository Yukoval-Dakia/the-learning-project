import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const LANE_NAMES = ['static', 'unit', 'db', 'migration', 'build', 'parity'];

// TS↔Rust grading parity needs the Rust toolchain, so it only runs when the numeric
// core, the crate, its TS twins, dependencies or this gate change (and on full runs).
const PARITY_PATHS = [
  /^crates\/calibration-native\//,
  /^src\/core\/(?:poly-exp|coldstart-solver|theta-grid)[^/]*\.ts$/,
  /^src\/server\/calibration\//,
  /^package\.json$/,
  /^pnpm-lock\.yaml$/,
  /^vitest\.(?:shared|unit\.config)\.ts$/,
  /^\.github\/workflows\/ci-gate\.yml$/,
  /^scripts\/ci\/gate-plan\.mjs$/,
];

const emptyLanes = () => Object.fromEntries(LANE_NAMES.map((lane) => [lane, false]));
const fullLanes = () => Object.fromEntries(LANE_NAMES.map((lane) => [lane, true]));

function normalizePath(file) {
  return file.replaceAll('\\', '/').replace(/^\.\/+/, '');
}

function isDocsOnly(file) {
  if (file.startsWith('.remember/')) return true;
  if (file.startsWith('docs/')) return /\.(?:md|mdx|txt|png|jpe?g|gif|webp|svg|pdf)$/i.test(file);
  if (!file.includes('/') && file.endsWith('.md')) return true;
  if (file.startsWith('.agents/') || file.startsWith('.claude/')) return file.endsWith('.md');
  return /\/(?:AGENTS|CLAUDE|CONTEXT|README)\.md$/.test(file);
}

export function classifyChangedFiles(inputFiles, { forceFullReason } = {}) {
  const files = [...new Set(inputFiles.map(normalizePath))].sort();
  const codeChanged = Boolean(forceFullReason) || files.some((file) => !isDocsOnly(file));
  const lanes = codeChanged ? fullLanes() : emptyLanes();
  lanes.parity =
    Boolean(forceFullReason) || files.some((file) => PARITY_PATHS.some((re) => re.test(file)));
  return {
    schema_version: 1,
    code_changed: codeChanged,
    changed_files: files,
    lanes,
    reasons: forceFullReason ? [forceFullReason] : codeChanged ? ['core-code-change'] : [],
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
  appendOutput('merge_base', mergeBase);
  appendOutput('plan_json', JSON.stringify(plan));
  writeSummary(plan, mergeBase);
  console.log(JSON.stringify({ ...plan, merge_base: mergeBase }, null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
