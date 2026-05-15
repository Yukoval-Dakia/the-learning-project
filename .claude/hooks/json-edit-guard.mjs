#!/usr/bin/env node
// Pre-write guard for JSON files. Validates the *result* of an Edit or Write
// before it touches disk; exits 2 with stderr to block the tool call.
//
// Wired in .claude/settings.json as PreToolUse on Edit|Write.
// Skips silently for non-.json files and for any internal failure (so a buggy
// guard never blocks unrelated work — the PostToolUse fallback still flags
// corruption after the fact).

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

const replaceOnce = (haystack, needle, replacement) => {
  const i = haystack.indexOf(needle);
  if (i === -1) return null;
  return haystack.slice(0, i) + replacement + haystack.slice(i + needle.length);
};

const main = async () => {
  const raw = await readStdin();
  const event = JSON.parse(raw);
  const input = event.tool_input ?? {};
  const filePath = input.file_path;

  if (typeof filePath !== 'string' || !filePath.endsWith('.json')) {
    process.exit(0);
  }

  let next;
  if (typeof input.content === 'string') {
    next = input.content;
  } else if (
    typeof input.old_string === 'string' &&
    typeof input.new_string === 'string'
  ) {
    let current;
    try {
      current = readFileSync(filePath, 'utf8');
    } catch {
      process.exit(0);
    }
    next = input.replace_all
      ? current.split(input.old_string).join(input.new_string)
      : replaceOnce(current, input.old_string, input.new_string);
    if (next === null) process.exit(0);
  } else {
    process.exit(0);
  }

  try {
    JSON.parse(next);
  } catch (err) {
    process.stderr.write(
      `Refusing to write invalid JSON to ${filePath}: ${err.message}\n`,
    );
    process.exit(2);
  }
  process.exit(0);
};

main().catch((err) => {
  process.stderr.write(`json-edit-guard internal error: ${err.message}\n`);
  process.exit(0);
});
