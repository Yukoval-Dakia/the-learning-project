#!/usr/bin/env node

import {
  currentHashes,
  pruneExpiredBaselines,
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

    // Preserve an existing resume baseline. If it was lost or expired, Stop
    // validates every dirty JSON file before writing a replacement baseline.
    if (event?.source === 'resume') return;

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
