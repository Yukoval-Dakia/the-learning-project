#!/usr/bin/env node
// Pre-Bash guard for risky git commands. Wired in .claude/settings.json as
// PreToolUse on Bash. Blocks four classes:
//   1. `git branch -D` / `git branch --delete --force` — force delete
//   2. `git push --force` / `--force-with-lease` — rewrites shared history
//   3. `git commit` on main/master — should be on a feature branch
//   4. `git worktree remove --force` — discards uncommitted lane work
// Exit 2 + stderr to block. Internal failures exit 0 so a buggy guard never
// blocks unrelated work — matches the json-edit-guard convention.
//
// Uses token-based parsing so:
//   - git global options (`-C <path>`, `-c key=value`, `--git-dir`,
//     `--no-pager`, etc.) don't break subcommand matching — earlier
//     regex-only version would silently pass `git -C /repo branch -D foo`
//   - `-C <path>` / `--git-dir <path>` / `--work-tree <path>` override
//     the cwd used to resolve the current branch (so commit-on-main is
//     judged against the target repo, not the hook process's cwd)
//   - a leading `cd <path> &&` is also honored as a cwd override (covers
//     the `cd <other-repo> && git commit ...` pattern)
//
// Known limitations (intentional pragmatic scope):
//   - Tokenisation splits by whitespace only; quoting / escaping is not
//     honored. Good enough for hook defense — Claude's Bash invocations
//     follow a narrow set of patterns and we're not defending against
//     adversarial input.
//   - Only the leading `cd <path>` in a chained command is tracked. A
//     mid-chain `... && cd <other-path> && git ...` keeps the leading
//     cwd. Rare pattern; documented as a follow-up if it ever bites.
//   - Subcommand aliases (e.g. user-defined `git co` for checkout) are
//     not expanded — hook keys on canonical names.

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

// Look up the current branch in the target repo. When `cwdOverride` is set
// we pass `-C <cwd>` to git itself rather than spawning with `cwd:` — that
// way an invalid override returns an error (caught below) instead of
// silently inheriting the hook process cwd.
const currentBranch = (cwdOverride) => {
  try {
    const args = cwdOverride
      ? ['-C', cwdOverride, 'branch', '--show-current']
      : ['branch', '--show-current'];
    return execFileSync('git', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
};

// Git global options that take a value as the NEXT whitespace-separated
// token. Required so the parser can step over `-C /repo` / `--git-dir /p`
// between `git` and the subcommand.
const GLOBAL_OPTS_TAKING_VALUE = new Set([
  '-C',
  '-c',
  '--git-dir',
  '--work-tree',
  '--namespace',
  '--super-prefix',
  '--config-env',
  '--exec-path',
]);

// Subset of GLOBAL_OPTS_TAKING_VALUE whose value names a working directory
// or git-dir we should consult for branch resolution.
const CWD_OVERRIDE_OPTS = new Set(['-C', '--git-dir', '--work-tree']);

// Shell control operators that end a single command's args slice. Only
// scanned at the token level — pipes / redirects inside quoted strings are
// not detected (acceptable per the limitations note above).
const SHELL_OPERATORS = new Set(['|', '||', ';', '&&', '&', '|&']);

// Match a `cd <path> &&` immediately at the start of the command. Quoted
// forms accepted, escape sequences are not.
const parseLeadingCd = (cmd) => {
  const m = cmd.match(
    /^\s*cd\s+(?:"([^"]+)"|'([^']+)'|(\S+))\s*&&\s*/,
  );
  if (!m) return null;
  return m[1] || m[2] || m[3] || null;
};

// Walk `tokens` from `gitIdx` (position of the `git` token) past any
// recognised global options to find the subcommand. Returns
// `{ subcommand, subcommandIdx, cwdOverride }` or `null` if no subcommand
// exists. Unknown options are treated as no-value, which is safe because
// subcommands never start with `-`.
const parseGitInvocation = (tokens, gitIdx) => {
  let i = gitIdx + 1;
  let cwdOverride = null;

  while (i < tokens.length) {
    const t = tokens[i];
    if (!t.startsWith('-')) break; // first non-flag token is the subcommand

    // --key=value form (one token)
    if (t.startsWith('--') && t.includes('=')) {
      const eq = t.indexOf('=');
      const key = t.slice(0, eq);
      const val = t.slice(eq + 1);
      if (CWD_OVERRIDE_OPTS.has(key)) cwdOverride = val;
      i += 1;
      continue;
    }

    // Option that takes the next token as its value
    if (GLOBAL_OPTS_TAKING_VALUE.has(t)) {
      const val = tokens[i + 1];
      if (CWD_OVERRIDE_OPTS.has(t) && val !== undefined) cwdOverride = val;
      i += 2;
      continue;
    }

    // No-value option (or unknown — assume no value)
    i += 1;
  }

  if (i >= tokens.length) return null;
  return { subcommand: tokens[i], subcommandIdx: i, cwdOverride };
};

// Collect tokens from `startIdx` up to (but not including) the next shell
// operator. Returns the slice array; caller can join for regex matching.
const collectArgs = (tokens, startIdx) => {
  const slice = [];
  for (let j = startIdx; j < tokens.length; j += 1) {
    if (SHELL_OPERATORS.has(tokens[j])) break;
    slice.push(tokens[j]);
  }
  return slice;
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

  const tokens = cmd.split(/\s+/).filter((t) => t.length > 0);
  const leadingCdCwd = parseLeadingCd(cmd);

  let i = 0;
  while (i < tokens.length) {
    if (tokens[i] !== 'git') {
      i += 1;
      continue;
    }
    const inv = parseGitInvocation(tokens, i);
    if (!inv) {
      i += 1;
      continue;
    }
    const cwd = inv.cwdOverride ?? leadingCdCwd ?? null;
    const argsSlice = collectArgs(tokens, inv.subcommandIdx);
    const args = argsSlice.join(' ');

    // 1. force branch delete
    if (
      inv.subcommand === 'branch' &&
      /(?:^|\s)(?:-D\b|--delete\s+--force\b|--force\s+--delete\b)/.test(args)
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
    if (
      inv.subcommand === 'push' &&
      (/(?:^|\s)-[a-zA-Z]*f[a-zA-Z]*\b/.test(args) ||
        /(?:^|\s)--force(?:-with-lease)?\b/.test(args))
    ) {
      block(
        'refused `git push --force` / `--force-with-lease`.\n' +
          'Force push overwrites shared history.\n' +
          'If intentional, run it in your own shell.',
      );
    }

    // 3. commit on protected branch
    if (inv.subcommand === 'commit') {
      const branch = currentBranch(cwd);
      if (branch === 'main' || branch === 'master') {
        block(
          `refused \`git commit\` on protected branch \`${branch}\`.\n` +
            'Create a feature branch: `git checkout -b feat/<name>`.\n' +
            'If intentional (e.g., docs-only commit on main), run in your own shell.',
        );
      }
    }

    // 4. worktree remove --force
    if (inv.subcommand === 'worktree' && argsSlice[1] === 'remove') {
      const tail = argsSlice.slice(2).join(' ');
      if (
        /(?:^|\s)-[a-zA-Z]*f[a-zA-Z]*\b/.test(tail) ||
        /(?:^|\s)--force\b/.test(tail)
      ) {
        block(
          'refused `git worktree remove --force`. Discards uncommitted lane work.\n' +
            'Use `git worktree remove <path>` without --force — git will refuse if dirty,\n' +
            'which is the safety you want.',
        );
      }
    }

    // Advance past this invocation's args before scanning for the next `git`
    i = inv.subcommandIdx + argsSlice.length;
  }

  process.exit(0);
};

main().catch((err) => {
  process.stderr.write(`git-guard internal error: ${err.message}\n`);
  process.exit(0);
});
