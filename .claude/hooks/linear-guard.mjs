#!/usr/bin/env node
// Pre-Bash guard for Linear-tracked commits. Wired in .claude/settings.json as
// PreToolUse on Bash. Blocks `git commit` when:
//   - the current branch suggests Linear-tracked phase work (yuk-*, foundation-*,
//     feat/yuk-*, chore/linear-*, etc.); AND
//   - the commit message body / title lacks a `YUK-NN` reference.
//
// Per docs/agents/issue-tracker.md, the Linear GitHub integration uses commit
// messages (not PR bodies alone) to link work. A commit without YUK-NN on a
// Linear-scoped branch silently breaks that integration, and the agent only
// notices when reconciling state much later. This hook is the cheap deterministic
// catch.
//
// Exit 2 + stderr to block. Bypass = rewrite the commit message to include
// YUK-NN, or commit from your own shell (hook only inspects Claude Bash calls).
// Internal failures exit 0 so a buggy guard never blocks unrelated work —
// matches the git-guard / json-edit-guard convention.

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const readStdin = () =>
  new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => resolve(data));
  });

const block = (msg) => {
  process.stderr.write(`linear-guard: ${msg}\n`);
  process.exit(2);
};

const currentBranch = (cwd) => {
  try {
    const args = cwd ? ['-C', cwd, 'branch', '--show-current'] : ['branch', '--show-current'];
    return execFileSync('git', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
};

// Branches that suggest Linear-tracked work. Conservative — only block when we
// have strong signal. Generic `chore/`, `fix/`, `docs/` branches are NOT blocked
// because they are commonly used for one-off operational work that doesn't map
// to a Linear issue.
const LINEAR_BRANCH_PATTERNS = [
  /^yuk-\d+/i, // Linear-native gitBranchName e.g. yuk-27-foo
  /\/yuk-\d+/i, // namespaced e.g. yukovaldakia09/yuk-27-foo
  /^(feat|fix)\/yuk-\d+/i, // explicit prefix
  /^foundation-(closeout|.*-acid)/i, // phase / acid-test branches
  /^foundation\/.+/i,
  /\/p\d+-/, // phase-style e.g. foundation-closeout/p0-physics-profile
];

const branchSuggestsLinear = (branch) => {
  if (!branch) return false;
  return LINEAR_BRANCH_PATTERNS.some((re) => re.test(branch));
};

const YUK_REGEX = /\bYUK-\d+\b/;

// Parse the commit message from the bash command. Handles:
//   - git commit -m "..."
//   - git commit -m '...'
//   - git commit -F <file>
//   - git commit -F-  (stdin — we can't see content, conservatively skip)
//   - git commit -m "$(cat <<EOF ... EOF)" (HEREDOC substitution — opaque, skip)
//   - git commit (no message — opens editor; we can't see content, skip)
// Returns: string (full message text), or null if we couldn't extract / opaque.
const extractCommitMessage = (cmd) => {
  // Check HEREDOC patterns FIRST, before -m extraction. The -m regex would
  // otherwise greedily match the literal `$(cat <<...)` substitution text
  // and miss the dynamic content.
  if (/\$\(cat\s+<<-?\s*['"]?EOF/.test(cmd)) return null;
  // Also catch `... | git commit -F -` (message piped via stdin)
  if (/\bgit\s+commit\b[^|;&\n]*\s-F\s+-(?:\s|$)/.test(cmd)) return null;

  // -m "..." / -m '...'
  const mDouble = cmd.match(/(?:^|\s)-m\s+"((?:[^"\\]|\\.)*)"/);
  if (mDouble) return mDouble[1];
  const mSingle = cmd.match(/(?:^|\s)-m\s+'((?:[^'\\]|\\.)*)'/);
  if (mSingle) return mSingle[1];

  // -F <file> (read the file from disk)
  const mFile = cmd.match(/(?:^|\s)-F\s+(\S+)/);
  if (mFile) {
    const fp = mFile[1];
    if (fp === '-') return null; // stdin — can't see
    try {
      return readFileSync(fp, 'utf8');
    } catch {
      return null;
    }
  }

  return null;
};

// Find a `cd <path> &&` prefix that overrides the cwd for the git invocation.
// Same approach as git-guard.mjs.
const parseLeadingCd = (cmd) => {
  const m = cmd.match(/^\s*cd\s+(?:"([^"]+)"|'([^']+)'|(\S+))\s*&&\s*/);
  if (!m) return null;
  return m[1] || m[2] || m[3] || null;
};

// Detect git's `-C <path>` global option (or `--git-dir=<path>` / `--work-tree=<path>`).
// Git uses the option that sits between `git` and the subcommand. We scan
// loosely; multiple matches keep the first (closest to `git`).
const parseGitCwdOption = (cmd) => {
  const m = cmd.match(/\bgit(?:\s+--[a-z-]+(?:=\S+)?)*\s+-C\s+(\S+)/);
  if (m) return m[1];
  const mGd = cmd.match(/\bgit[^|;&\n]*?--git-dir[= ](\S+)/);
  if (mGd) return mGd[1];
  const mWt = cmd.match(/\bgit[^|;&\n]*?--work-tree[= ](\S+)/);
  if (mWt) return mWt[1];
  return null;
};

const main = async () => {
  const raw = await readStdin();
  let event;
  try {
    event = JSON.parse(raw);
  } catch {
    process.exit(0);
  }
  const cmd = event?.tool_input?.command;
  if (typeof cmd !== 'string' || !/\bgit\b/.test(cmd) || !/\bcommit\b/.test(cmd)) {
    process.exit(0);
  }
  // Pre-filter accepts any cmd with both `git` and `commit` tokens — covers
  // both `git commit` and `git -C <path> commit` forms. Downstream extractor
  // returns null for non-commit subcommands lacking -m/-F (e.g. `git push`),
  // so we don't false-block. The only edge case that falls through is e.g.
  // `git tag -m "..."` lacking YUK — block message there is informative
  // enough that the user can bypass by adding YUK or running in own shell.

  // cwd resolution priority: explicit git -C / --git-dir / --work-tree takes
  // precedence over `cd <path> &&` prefix (git's own opts are evaluated after
  // the shell `cd` runs, so they override).
  const cwdOverride = parseGitCwdOption(cmd) ?? parseLeadingCd(cmd);
  const branch = currentBranch(cwdOverride);
  if (!branchSuggestsLinear(branch)) {
    process.exit(0);
  }

  const message = extractCommitMessage(cmd);
  // Opaque message form (HEREDOC / stdin / editor) — don't false-block.
  if (message === null) {
    process.exit(0);
  }

  if (YUK_REGEX.test(message)) {
    process.exit(0);
  }

  block(
    `commit on Linear-tracked branch \`${branch}\` lacks a YUK-NN reference.\n` +
      'Add `Closes YUK-NN` (or `Fixes YUK-NN` / `Part of YUK-NN`) to the message:\n' +
      '  - the Linear GitHub integration scans COMMIT MESSAGES (not PR body alone)\n' +
      '  - silent failure mode: integration sees no link, no attachment / no assign,\n' +
      "    and you don't notice until reconciling Linear state later\n" +
      'Bypass options:\n' +
      '  - rewrite the message to include YUK-NN (preferred)\n' +
      '  - if this commit truly is not Linear-tracked work, run it from your own shell',
  );
};

main().catch((err) => {
  process.stderr.write(`linear-guard internal error: ${err.message}\n`);
  process.exit(0);
});
