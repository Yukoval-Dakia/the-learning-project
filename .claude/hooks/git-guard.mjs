#!/usr/bin/env node
// Pre-Bash guard for risky git commands. Wired in .claude/settings.json as
// PreToolUse on Bash. Blocks four classes:
//   1. `git branch -D` / `git branch --delete --force` — force delete
//   2. `git push --force` / `--force-with-lease` — rewrites shared history
//   3. `git commit` on main/master — should be on a feature branch
//   4. `git worktree remove --force` — discards uncommitted lane work
// Exit 2 + stderr to block. Internal failures exit 0 so a buggy guard never
// blocks unrelated work — matches the json-edit-guard convention.

import { execFileSync } from 'node:child_process';

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
  process.stderr.write(`git-guard: ${msg}\n`);
  process.exit(2);
};

const currentBranch = () => {
  try {
    return execFileSync('git', ['branch', '--show-current'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
};

// Return the args slice of a `git <sub>` subcommand, stopping at shell operators.
// subRegex is a RegExp source string (escape backslashes as in any JS string literal).
const sliceGitSub = (cmd, subRegex) => {
  const re = new RegExp(`\\bgit\\s+${subRegex}\\b[^|;&\\n]*`);
  const m = cmd.match(re);
  return m ? m[0] : null;
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
  if (typeof cmd !== 'string' || !/\bgit\b/.test(cmd)) {
    process.exit(0);
  }

  // 1. force branch delete
  const branchSlice = sliceGitSub(cmd, 'branch');
  if (
    branchSlice &&
    /\s(-D\b|--delete\s+--force\b|--force\s+--delete\b)/.test(branchSlice)
  ) {
    block(
      'refused `git branch -D` (force delete).\n' +
        'Use `git branch -d` after verifying ff-merge feasibility:\n' +
        '  git log --oneline <target>..<source>  # should show commits\n' +
        '  git log --oneline <source>..<target>  # should be empty\n' +
        'If you really need force delete, run it in your own shell.',
    );
  }

  // 2. force push
  const pushSlice = sliceGitSub(cmd, 'push');
  if (
    pushSlice &&
    (/\s-[a-zA-Z]*f[a-zA-Z]*\b/.test(pushSlice) ||
      /\s--force(?:-with-lease)?\b/.test(pushSlice))
  ) {
    block(
      'refused `git push --force` / `--force-with-lease`.\n' +
        'Force push overwrites shared history.\n' +
        'If intentional, run it in your own shell.',
    );
  }

  // 3. commit on protected branch
  if (/\bgit\s+commit\b/.test(cmd)) {
    const branch = currentBranch();
    if (branch === 'main' || branch === 'master') {
      block(
        `refused \`git commit\` on protected branch \`${branch}\`.\n` +
          'Create a feature branch: `git checkout -b feat/<name>`.\n' +
          'If intentional (e.g., docs-only commit on main), run in your own shell.',
      );
    }
  }

  // 4. worktree remove --force
  const wtSlice = sliceGitSub(cmd, 'worktree\\s+remove');
  if (
    wtSlice &&
    (/\s-[a-zA-Z]*f[a-zA-Z]*\b/.test(wtSlice) || /\s--force\b/.test(wtSlice))
  ) {
    block(
      'refused `git worktree remove --force`. Discards uncommitted lane work.\n' +
        'Use `git worktree remove <path>` without --force — git will refuse if dirty,\n' +
        'which is the safety you want.',
    );
  }

  process.exit(0);
};

main().catch((err) => {
  process.stderr.write(`git-guard internal error: ${err.message}\n`);
  process.exit(0);
});
