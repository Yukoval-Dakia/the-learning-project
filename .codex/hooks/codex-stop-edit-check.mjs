#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  changedFiles,
  currentHashes,
  readBaseline,
  readHookEvent,
  repoRoot,
  sessionIdFrom,
  writeBaseline,
} from './codex-edit-baseline.mjs';

const stopOk = () => {
  process.stdout.write(JSON.stringify({ suppressOutput: true }));
  process.exit(0);
};

const stopWithFeedback = (reason) => {
  process.stdout.write(
    JSON.stringify({
      decision: 'block',
      reason,
      systemMessage: 'Repo stop check failed. Fix the reported JSON issue before replying.',
    }),
  );
  process.exit(0);
};

const main = () => {
  const event = readHookEvent();
  const root = repoRoot();
  const sessionId = sessionIdFrom(event);
  process.chdir(root);

  const currentFiles = changedFiles(root);
  const hashes = currentHashes(root);

  const baseline = readBaseline(root, sessionId);
  if (baseline === null) {
    writeBaseline(root, sessionId, hashes);
    stopOk();
  }

  const filesToCheck = currentFiles.filter((file) => {
    const hash = hashes[file];
    return hash && baseline[file] !== hash;
  });

  const jsonFiles = filesToCheck.filter((file) => file.endsWith('.json'));

  for (const file of jsonFiles) {
    try {
      JSON.parse(readFileSync(resolve(root, file), 'utf8'));
    } catch (err) {
      stopWithFeedback(`JSON invalid after edit: ${file}: ${err.message}`);
    }
  }

  writeBaseline(root, sessionId, hashes);
  stopOk();
};

main();
