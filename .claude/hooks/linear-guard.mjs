#!/usr/bin/env node
// Pre-Bash guard for Linear-tracked commits. Wired in .claude/settings.json as
// PreToolUse on Bash. Blocks `git commit` when:
//   - the current branch suggests Linear-tracked phase work (yuk-*, foundation-*,
//     feat/yuk-*, etc.); AND
//   - the combined commit message (all -m / -F segments) lacks a `YUK-NN`
//     reference.
//
// Per docs/agents/issue-tracker.md, the Linear GitHub integration scans commit
// MESSAGES (not PR body alone) to link work. A commit without YUK-NN on a
// Linear-scoped branch silently breaks that integration; the agent only
// notices when reconciling Linear state much later. This hook is the cheap
// deterministic catch.
//
// Also blocks shorthand like `Closes YUK-27 + YUK-28`: observed 2026-05-23,
// Linear only attached/closed the first issue. Repeat the keyword per issue:
// `Closes YUK-27` + `Closes YUK-28`.
//
// Exit 2 + stderr to block. Bypass = rewrite the commit message to include
// YUK-NN, or commit from your own shell (hook only inspects Claude Bash calls).
// Internal failures exit 0 so a buggy guard never blocks unrelated work —
// matches git-guard / json-edit-guard convention.
//
// Parser handles (codex review 2026-05-23 findings on PR #95):
//   - multiple -m / --message (all segments joined for YUK check)
//   - long options --message=<msg> / --file=<file> (= and space forms)
//   - -F <file> resolved relative to the target repo cwd
//   - multiple -C with relative resolution (git semantics — each non-absolute
//     -C is resolved relative to the previous one)
//   - global opts preceding -C (-c k=v / --no-pager / -p / etc.)
//   - leading `cd <path> && [cd <path> && ...]` chain
//   - HEREDOC / stdin / editor mode → opaque, skip silently

import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';

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

const LINEAR_BRANCH_PATTERNS = [
  /^yuk-\d+/i,
  /\/yuk-\d+/i,
  /^(feat|fix)\/yuk-\d+/i,
  /^foundation-(closeout|.*-acid)/i,
  /^foundation\/.+/i,
  /\/p\d+-/,
];

const branchSuggestsLinear = (branch) => {
  if (!branch) return false;
  return LINEAR_BRANCH_PATTERNS.some((re) => re.test(branch));
};

const YUK_REGEX = /\bYUK-\d+\b/;
const LINEAR_KEYWORD_REFERENCE_REGEX =
  /\b(?:closes?|closed|fix(?:e[sd])?|resolve[sd]?|part of|refs?|references?)\s+YUK-\d+\b/gi;

const findAmbiguousLinearKeywordList = (text) => {
  const matches = Array.from(text.matchAll(LINEAR_KEYWORD_REFERENCE_REGEX));
  for (let i = 0; i < matches.length; i += 1) {
    const match = matches[i];
    const segmentStart = match.index + match[0].length;
    const segmentEnd =
      i + 1 < matches.length ? matches[i + 1].index : text.length;
    const trailingSegment = text.slice(segmentStart, segmentEnd);
    const bareIssue = trailingSegment.match(YUK_REGEX);
    if (!bareIssue) continue;

    return {
      issue: bareIssue[0],
      snippet: `${match[0]}${trailingSegment}`
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 160),
    };
  }
  return null;
};

// ---------- tokenizer ----------
// Whitespace split with awareness of single / double quoted segments.
// Not a full shell parser — does not handle escaped spaces outside quotes,
// nested quotes, $(...) substitution beyond pass-through. Good enough for
// our use: dropped quotes around argument values, preserved content.
const tokenize = (cmd) => {
  const tokens = [];
  let i = 0;
  const n = cmd.length;
  while (i < n) {
    while (i < n && /\s/.test(cmd[i])) i += 1;
    if (i >= n) break;
    let tok = '';
    while (i < n && !/\s/.test(cmd[i])) {
      const c = cmd[i];
      if (c === '"' || c === "'") {
        const quote = c;
        i += 1;
        while (i < n && cmd[i] !== quote) {
          if (cmd[i] === '\\' && quote === '"' && i + 1 < n) {
            tok += cmd[i + 1];
            i += 2;
          } else {
            tok += cmd[i];
            i += 1;
          }
        }
        i += 1; // skip closing quote
      } else {
        tok += c;
        i += 1;
      }
    }
    tokens.push(tok);
  }
  return tokens;
};

// ---------- leading cd chain ----------
// Returns { tokens: tokensAfter, cwd: resolvedAbsoluteCwd | null }.
// Honors a chain `cd <a> && cd <b> && ...` at the start. Each non-absolute
// path resolved relative to the previous cwd. Stops on non-cd token.
const parseLeadingCdChain = (tokens) => {
  let cwd = null;
  let i = 0;
  while (i + 1 < tokens.length && tokens[i] === 'cd') {
    const target = tokens[i + 1];
    cwd = cwd ? path.resolve(cwd, target) : path.resolve(target);
    // After the cd <target>, require &&
    if (tokens[i + 2] !== '&&') break;
    i += 3;
  }
  return { tokens: tokens.slice(i), cwd };
};

// ---------- git global options ----------
// After a `git` token, walk and skip global options. Track the cumulative
// cwd from -C / --git-dir / --work-tree (each resolved relative to the
// previous cwd per git docs). Return { subcommandIdx, cwdOverride } —
// subcommandIdx is the index in the original tokens array of the first
// non-flag token after global opts.
const KNOWN_VALUE_OPTS = new Set([
  '-C',
  '-c',
  '--git-dir',
  '--work-tree',
  '--namespace',
  '--super-prefix',
  '--config-env',
  '--exec-path',
  '--list-cmds',
  '--attr-source',
]);

const CWD_AFFECTING_OPTS = new Set(['-C', '--git-dir', '--work-tree']);

const parseGitGlobalOpts = (tokens, gitIdx, baseCwd) => {
  let cwd = baseCwd;
  let i = gitIdx + 1;
  while (i < tokens.length) {
    const t = tokens[i];
    if (!t.startsWith('-')) break;

    // --key=value form
    if (t.startsWith('--') && t.includes('=')) {
      const eq = t.indexOf('=');
      const key = t.slice(0, eq);
      const val = t.slice(eq + 1);
      if (CWD_AFFECTING_OPTS.has(key) && val !== '') {
        cwd = cwd ? path.resolve(cwd, val) : path.resolve(val);
      }
      i += 1;
      continue;
    }

    // -X / --xxx that takes the next token as value
    if (KNOWN_VALUE_OPTS.has(t)) {
      const val = tokens[i + 1];
      if (CWD_AFFECTING_OPTS.has(t) && val !== undefined && val !== '') {
        cwd = cwd ? path.resolve(cwd, val) : path.resolve(val);
      }
      i += 2;
      continue;
    }

    // No-value flag (-p / --no-pager / --paginate / --version / unknown -X)
    // Conservative: assume no value (git's actual valued global opts are
    // listed in KNOWN_VALUE_OPTS).
    i += 1;
  }
  if (i >= tokens.length) return null;
  return { subcommandIdx: i, cwdOverride: cwd };
};

// ---------- commit-args message collection ----------
// Walk tokens after subcommand, collect all message-bearing segments.
// Returns: { text: combined message string, opaque: bool, finalCwd: string|null }
// opaque = true means we saw a form we can't fully resolve (HEREDOC / stdin /
// no -m / -F at all but commit not in opaque-skip mode either). In that case
// caller should not block.
const SHELL_OPERATORS = new Set(['|', '||', ';', '&&', '&', '|&', '>', '>>', '<']);

const collectCommitMessage = (tokens, startIdx, cwd) => {
  const segments = [];
  let opaque = false;
  let sawAnyMessageSource = false;

  for (let i = startIdx; i < tokens.length; i += 1) {
    const t = tokens[i];
    if (SHELL_OPERATORS.has(t)) break;

    // -m <msg>
    if (t === '-m' || t === '--message') {
      const val = tokens[i + 1];
      if (val === undefined) {
        opaque = true;
        break;
      }
      segments.push(val);
      sawAnyMessageSource = true;
      i += 1;
      continue;
    }
    // -m=<msg> (rare but accept) / --message=<msg>
    if (t.startsWith('-m=')) {
      segments.push(t.slice(3));
      sawAnyMessageSource = true;
      continue;
    }
    if (t.startsWith('--message=')) {
      segments.push(t.slice('--message='.length));
      sawAnyMessageSource = true;
      continue;
    }

    // -F <file>
    if (t === '-F' || t === '--file') {
      const fp = tokens[i + 1];
      if (fp === undefined) {
        opaque = true;
        break;
      }
      if (fp === '-') {
        opaque = true;
        i += 1;
        continue;
      }
      const resolved = path.isAbsolute(fp) ? fp : path.resolve(cwd ?? process.cwd(), fp);
      try {
        segments.push(readFileSync(resolved, 'utf8'));
        sawAnyMessageSource = true;
      } catch {
        // File not readable from our cwd context — treat as opaque rather than
        // false-block. Codex finding 4: previous code silently dropped this.
        opaque = true;
      }
      i += 1;
      continue;
    }
    if (t.startsWith('-F=')) {
      const fp = t.slice(3);
      if (fp === '-') {
        opaque = true;
        continue;
      }
      const resolved = path.isAbsolute(fp) ? fp : path.resolve(cwd ?? process.cwd(), fp);
      try {
        segments.push(readFileSync(resolved, 'utf8'));
        sawAnyMessageSource = true;
      } catch {
        opaque = true;
      }
      continue;
    }
    if (t.startsWith('--file=')) {
      const fp = t.slice('--file='.length);
      if (fp === '-') {
        opaque = true;
        continue;
      }
      const resolved = path.isAbsolute(fp) ? fp : path.resolve(cwd ?? process.cwd(), fp);
      try {
        segments.push(readFileSync(resolved, 'utf8'));
        sawAnyMessageSource = true;
      } catch {
        opaque = true;
      }
      continue;
    }
  }

  // No -m / -F at all → editor mode (opaque, skip)
  if (!sawAnyMessageSource) opaque = true;

  return { text: segments.join('\n\n'), opaque };
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
  if (typeof cmd !== 'string') process.exit(0);

  // Detect HEREDOC substitution early — content is opaque.
  if (/\$\(cat\s+<<-?\s*['"]?EOF/.test(cmd)) process.exit(0);

  // Quick reject: must mention both `git` and `commit` somewhere.
  if (!/\bgit\b/.test(cmd) || !/\bcommit\b/.test(cmd)) process.exit(0);

  const tokens = tokenize(cmd);
  const { tokens: afterCd, cwd: baseCwd } = parseLeadingCdChain(tokens);

  // Find the `git` token in afterCd. Could be many in chained cmds; we only
  // need the first git that has a `commit` subcommand within its arg slice.
  // For simplicity walk first git only — if there are multiple git invocations
  // chained with && / ;, the next round of agent loop will process them.
  for (let gi = 0; gi < afterCd.length; gi += 1) {
    if (afterCd[gi] !== 'git') continue;
    const inv = parseGitGlobalOpts(afterCd, gi, baseCwd);
    if (!inv) break;
    const subcommand = afterCd[inv.subcommandIdx];
    if (subcommand !== 'commit') {
      // skip to next potential git on the same chain
      continue;
    }
    const branch = currentBranch(inv.cwdOverride);
    if (!branchSuggestsLinear(branch)) process.exit(0);

    const { text, opaque } = collectCommitMessage(
      afterCd,
      inv.subcommandIdx + 1,
      inv.cwdOverride,
    );
    if (opaque) process.exit(0);
    const ambiguousKeywordList = findAmbiguousLinearKeywordList(text);
    if (ambiguousKeywordList) {
      block(
        `commit on Linear-tracked branch \`${branch}\` uses one Linear keyword for multiple issues.\n` +
          `Problem segment: \`${ambiguousKeywordList.snippet}\`\n` +
          `Repeat the magic keyword before \`${ambiguousKeywordList.issue}\`, e.g. ` +
          '`Closes YUK-27` and `Closes YUK-28`.\n' +
          'Linear may only attach / close the first issue in shorthand like `Closes YUK-27 + YUK-28`.',
      );
    }
    if (YUK_REGEX.test(text)) process.exit(0);

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
  }
  process.exit(0);
};

main().catch((err) => {
  process.stderr.write(`linear-guard internal error: ${err.message}\n`);
  process.exit(0);
});
