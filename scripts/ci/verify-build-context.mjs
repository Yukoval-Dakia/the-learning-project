import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { validatePins, violation } from './green-bridge-pins.mjs';

export const METADATA_KEY = 'green-bridge-context';

const FULL_SHA = /^[0-9a-f]{40}$/;
const isFullSha = (value) => value !== null && value !== undefined && FULL_SHA.test(value);

function requireFullSha(value, code, label) {
  return value !== undefined && !FULL_SHA.test(value)
    ? [violation(code, `${label} must be a full lowercase 40-hex sha`, '40-hex', value)]
    : [];
}

function pullRequestNumber(raw) {
  if (raw === undefined || raw === '' || raw === 'false') return null;
  if (!/^\d+$/.test(raw)) return Number.NaN;
  return Number.parseInt(raw, 10);
}

export function validateContext({ env, git, pinsText = null, pinsError = null, now = new Date() }) {
  const violations = [];
  const commit = env.BUILDKITE_COMMIT;
  const isBuildkite = env.BUILDKITE === 'true';

  if (!isBuildkite && env.GREEN_BRIDGE_LOCAL !== '1') {
    violations.push(
      violation(
        'not-buildkite-context',
        'expected BUILDKITE=true (set GREEN_BRIDGE_LOCAL=1 for GitHub parity runs)',
        'BUILDKITE=true',
        `BUILDKITE=${env.BUILDKITE ?? 'unset'}`,
      ),
    );
  }

  if (commit === undefined || commit === '') {
    violations.push(violation('commit-missing', 'BUILDKITE_COMMIT is required'));
  }
  violations.push(...requireFullSha(commit, 'commit-malformed', 'BUILDKITE_COMMIT'));

  const head = git.headCommit();
  if (head === null)
    violations.push(violation('head-unresolved', 'git rev-parse HEAD failed in the checkout'));
  if (isFullSha(head) && isFullSha(commit) && head !== commit) {
    violations.push(
      violation(
        'commit-head-mismatch',
        'BUILDKITE_COMMIT differs from the checked-out HEAD',
        commit,
        head,
      ),
    );
  }

  const headTree = git.headTree();
  if (!isFullSha(headTree)) {
    violations.push(
      violation('head-tree-unresolved', 'git rev-parse HEAD^{tree} did not resolve to a full sha'),
    );
  }

  const defaultBranch = env.BUILDKITE_PIPELINE_DEFAULT_BRANCH || 'main';
  const mergeBase = (branch) => git.mergeBaseSha(`origin/${branch}`);
  const baseSha = mergeBase(defaultBranch);
  if (!isFullSha(baseSha)) {
    violations.push(
      violation(
        'base-unresolved',
        `merge-base of HEAD against origin/${defaultBranch} did not resolve`,
      ),
    );
  }

  const prNumber = pullRequestNumber(env.BUILDKITE_PULL_REQUEST);
  let pr = null;
  if (Number.isNaN(prNumber)) {
    violations.push(
      violation(
        'pr-number-malformed',
        'BUILDKITE_PULL_REQUEST must be a PR number or "false"',
        'digits | false',
        env.BUILDKITE_PULL_REQUEST,
      ),
    );
  } else if (prNumber !== null) {
    // Buildkite checks the PR head out as HEAD, so the PR head sha is the verified commit itself.
    const prBaseBranch = env.BUILDKITE_PULL_REQUEST_BASE_BRANCH || defaultBranch;
    const prBaseSha = mergeBase(prBaseBranch);
    if (!isFullSha(prBaseSha)) {
      violations.push(
        violation(
          'pr-base-unresolved',
          `merge-base of HEAD against origin/${prBaseBranch} did not resolve`,
        ),
      );
    } else {
      pr = {
        number: prNumber,
        head_sha: commit ?? null,
        base_branch: prBaseBranch,
        base_sha: prBaseSha,
      };
    }
  }

  const githubSha = env.GITHUB_SHA;
  let github = null;
  if (
    githubSha !== undefined ||
    env.GITHUB_EVENT_NAME !== undefined ||
    env.GITHUB_EVENT_BEFORE !== undefined
  ) {
    github = {
      event_name: env.GITHUB_EVENT_NAME ?? null,
      sha: githubSha ?? null,
      before: env.GITHUB_EVENT_BEFORE ?? null,
    };
    violations.push(...requireFullSha(githubSha, 'github-sha-malformed', 'GITHUB_SHA'));
    if (isFullSha(githubSha) && isFullSha(commit) && githubSha !== commit) {
      violations.push(
        violation(
          'github-sha-mismatch',
          'GITHUB_SHA differs from BUILDKITE_COMMIT',
          commit,
          githubSha,
        ),
      );
    }
    violations.push(
      ...requireFullSha(env.GITHUB_EVENT_BEFORE, 'github-before-malformed', 'GITHUB_EVENT_BEFORE'),
    );
  }

  let pinsSection = null;
  let pinsOk = null;
  if (pinsError !== null) {
    violations.push(pinsError);
    pinsOk = false;
  } else if (pinsText !== null) {
    const pinsResult = validatePins({ pinsText, now });
    violations.push(...pinsResult.violations);
    pinsSection = pinsResult.record.pins;
    pinsOk = pinsResult.violations.length === 0;
  }

  const record = {
    schema_version: 1,
    mode: 'context',
    status: violations.length === 0 ? 'ok' : 'failed',
    build: {
      number: env.BUILDKITE_BUILD_NUMBER ?? null,
      pipeline: env.BUILDKITE_PIPELINE_SLUG ?? null,
      branch: env.BUILDKITE_BRANCH ?? null,
      commit: commit ?? null,
    },
    head: { commit: head, tree: headTree },
    base: { branch: defaultBranch, sha: baseSha },
    pr,
    github,
    pins: pinsSection,
    metadata: env.BUILDKITE_JOB_ID === undefined ? null : { key: METADATA_KEY, set: true },
    checks: {
      buildkite_context: isBuildkite,
      commit_matches_head: head !== null && head === commit,
      head_tree_resolved: isFullSha(headTree),
      base_present: isFullSha(baseSha),
      pr_head_present: prNumber === null ? null : commit !== undefined && commit !== '',
      github_sha_matches: githubSha === undefined ? null : githubSha === commit,
      pins_fresh: pinsOk,
    },
    violations,
  };
  return { record, violations };
}

export function markMetadataFailure(record, error) {
  record.metadata = { key: METADATA_KEY, set: false, error: error.slice(0, 300) };
  record.violations.push(
    violation('metadata-set-failed', `buildkite-agent meta-data set failed: ${error}`),
  );
  record.status = 'failed';
  return record;
}

function realGit(root) {
  const run = (args) => {
    try {
      const out = execFileSync('git', args, {
        cwd: root,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      return out.trim() || null;
    } catch {
      return null;
    }
  };
  return {
    headCommit: () => run(['rev-parse', 'HEAD']),
    headTree: () => run(['rev-parse', 'HEAD^{tree}']),
    mergeBaseSha: (ref) => run(['merge-base', 'HEAD', ref]),
  };
}

function loadPins(pinsPath) {
  if (existsSync(pinsPath)) return { text: readFileSync(pinsPath, 'utf8') };
  if (process.env.PINS_FILE !== undefined) return { error: `PINS_FILE=${pinsPath} does not exist` };
  return null;
}

function emit(record) {
  process.stdout.write(`${JSON.stringify(record)}\n`);
  process.exitCode = record.status === 'ok' ? 0 : 1;
}

function main() {
  const root = process.cwd();
  const pinsPath = path.resolve(process.env.PINS_FILE ?? '.buildkite/pins.env');
  const loaded = loadPins(pinsPath);

  if (process.argv.includes('--pins')) {
    if (loaded === null || loaded.error !== undefined) {
      const message = loaded === null ? `pins file not found at ${pinsPath}` : loaded.error;
      emit({
        schema_version: 1,
        mode: 'pins',
        status: 'failed',
        pins: null,
        violations: [violation('pins-unreadable', message)],
      });
      return;
    }
    emit(validatePins({ pinsText: loaded.text }).record);
    return;
  }

  const { record } = validateContext({
    env: process.env,
    git: realGit(root),
    pinsText: loaded?.text ?? null,
    pinsError: loaded?.error !== undefined ? violation('pins-unreadable', loaded.error) : null,
  });

  if (record.metadata !== null) {
    const result = spawnSync(
      'buildkite-agent',
      ['meta-data', 'set', METADATA_KEY, JSON.stringify(record)],
      {
        encoding: 'utf8',
      },
    );
    if (result.status !== 0) {
      markMetadataFailure(
        record,
        result.error?.message ??
          `buildkite-agent exited ${result.status ?? 'on a signal'}: ${(result.stderr ?? '').trim()}`,
      );
    }
  }

  emit(record);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
