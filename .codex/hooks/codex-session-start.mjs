#!/usr/bin/env node

import {
  currentHashes,
  pruneExpiredBaselines,
  readBaseline,
  readHookEvent,
  repoRoot,
  sessionIdFrom,
  writeBaseline,
} from './codex-edit-baseline.mjs';

const recordBaseline = (event) => {
  try {
    const root = repoRoot();
    const sessionId = sessionIdFrom(event);
    pruneExpiredBaselines();

    const isResume = event?.source === 'resume';
    if (isResume && readBaseline(root, sessionId) !== null) return;

    writeBaseline(root, sessionId, currentHashes(root));
  } catch {
    // Session context injection should not fail because the baseline helper did.
  }
};

const sessionStartOk = () => {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: '',
      },
    }),
  );
};

const event = readHookEvent();
recordBaseline(event);
sessionStartOk();
