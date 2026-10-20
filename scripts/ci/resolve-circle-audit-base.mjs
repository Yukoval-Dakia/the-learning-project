import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';

function fail(reason) {
  throw new Error(reason);
}

function git(args) {
  try {
    return execFileSync('git', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch {
    fail(`git ${args[0]} failed; cannot establish the comparison base`);
  }
}

function sha(value, label) {
  if (typeof value !== 'string' || !/^[a-f0-9]{40}$/.test(value) || /^0+$/.test(value)) {
    fail(`${label} is not a full, nonzero commit SHA`);
  }
  return value;
}

async function main() {
  // GitHub keeps its original event/input baseline. Circle's partial push event
  // omits `before`, so only this platform needs an independently verified source.
  if (process.env.CIRCLECI !== 'true') return;

  const token = process.env.GH_READ_TOKEN;
  if (!token) fail('No existing Circle GitHub token; owner configuration is required');
  const repo = process.env.GITHUB_REPOSITORY;
  if (!repo || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
    fail('GITHUB_REPOSITORY is missing or invalid');
  }
  const head = sha(process.env.BUILD_HEAD, 'Build head');
  if (git(['rev-parse', 'HEAD']) !== head) fail('Checkout HEAD differs from build head');
  const ref = process.env.BUILD_REF;
  if (!ref?.startsWith('refs/heads/')) fail('Only a verified branch build is supported');
  git(['check-ref-format', ref]);
  const branch = ref.slice('refs/heads/'.length);
  const event = process.env.BUILD_EVENT;
  if (!['push', 'pull_request'].includes(event))
    fail('Unsupported Circle event; no baseline guessed');

  async function api(path) {
    let response;
    try {
      response = await fetch(`https://api.github.com/repos/${repo}/${path}`, {
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/vnd.github+json',
          'X-GitHub-Api-Version': '2022-11-28',
        },
        redirect: 'error',
        signal: AbortSignal.timeout(15000),
      });
    } catch {
      fail('GitHub read request failed; no baseline selected');
    }
    if ([401, 403].includes(response.status)) {
      fail(`GitHub read credential rejected (${response.status}); owner configuration is required`);
    }
    if (!response.ok) fail(`GitHub read returned HTTP ${response.status}; no baseline selected`);
    try {
      return await response.json();
    } catch {
      fail('GitHub read returned invalid JSON');
    }
  }

  const commit = await api(`commits/${head}`);
  if (commit.sha !== head) fail('GitHub commit identity differs from build head');
  async function associatedPulls() {
    const items = [];
    for (let page = 1; page <= 10; page++) {
      const rows = await api(`commits/${head}/pulls?per_page=100&page=${page}`);
      if (!Array.isArray(rows)) fail('Invalid associated-PR response');
      items.push(...rows);
      if (rows.length < 100) return items;
    }
    fail('Associated-PR pagination exceeded its bound; uniqueness is unknown');
  }
  async function uniquePull(rows, label) {
    if (rows.length !== 1) fail(`Expected one ${label} PR; found ${rows.length}`);
    if (!Number.isSafeInteger(rows[0].number) || rows[0].number <= 0) fail('Invalid PR identity');
    const pull = await api(`pulls/${rows[0].number}`);
    if (
      pull.number !== rows[0].number ||
      pull.base?.repo?.full_name?.toLowerCase() !== repo.toLowerCase()
    ) {
      fail('PR identity or base repository changed');
    }
    return pull;
  }

  let base;
  let basis;
  let pullNumber;
  if (event === 'push' && branch === 'main') {
    if (process.env.PROVIDED_BEFORE) {
      base = sha(process.env.PROVIDED_BEFORE, 'Circle before');
      basis = 'circle-push-before';
    } else {
      const pull = await uniquePull(
        (await associatedPulls()).filter((p) => p.merged_at),
        'merged',
      );
      if (
        !pull.merged ||
        !pull.merged_at ||
        pull.state !== 'closed' ||
        pull.merge_commit_sha !== head ||
        pull.base?.ref !== 'main'
      ) {
        fail('Merged PR does not identify this exact main merge');
      }
      if (!Array.isArray(commit.parents) || commit.parents.length !== 2) {
        fail('Main has no before and HEAD is not a two-parent merge; squash/rebase is unsupported');
      }
      if (sha(commit.parents[1]?.sha, 'Second parent') !== sha(pull.head?.sha, 'Merged PR head')) {
        fail('Merge second parent differs from merged PR head');
      }
      base = sha(commit.parents[0]?.sha, 'Verified merge first parent');
      basis = 'verified-two-parent-merge';
      pullNumber = pull.number;
    }
  } else {
    const pull = await uniquePull(
      (await associatedPulls()).filter((p) => p.state === 'open'),
      'open',
    );
    if (
      pull.state !== 'open' ||
      pull.merged ||
      pull.head?.sha !== head ||
      pull.head?.ref !== branch
    ) {
      fail('Open PR head SHA/ref differs from this build');
    }
    base = sha(pull.base?.sha, 'Open PR base');
    basis = 'verified-open-pr';
    pullNumber = pull.number;
  }
  if (base === head) fail('Comparison base equals HEAD; refusing an empty audit boundary');
  if ((await api(`commits/${base}`)).sha !== base)
    fail('Comparison base is not the identified GitHub commit');
  // Fetch only the verified immutable commit, not a moving branch or guessed parent.
  try {
    execFileSync('git', ['cat-file', '-e', `${base}^{commit}`], { stdio: 'ignore' });
  } catch {
    git(['fetch', '--no-tags', 'origin', base]);
  }
  git(['cat-file', '-e', `${base}^{commit}`]);
  if (event === 'push' && branch === 'main') git(['merge-base', '--is-ancestor', base, head]);
  if (!process.env.GITHUB_OUTPUT) fail('GITHUB_OUTPUT is unavailable');
  appendFileSync(process.env.GITHUB_OUTPUT, `base=${base}\n`);
  console.log(JSON.stringify({ head, ref, event, base, basis, pullNumber }));
}

main().catch((error) => {
  console.error(`[circle-audit-base] ${error.message}`);
  process.exitCode = 1;
});
