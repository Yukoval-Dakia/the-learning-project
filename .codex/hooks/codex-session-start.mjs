#!/usr/bin/env node

const context = [
  'codebase-retrieval MCP is configured globally for semantic code search.',
  'For broad cross-file semantic search, load it with tool_search before falling back to ad-hoc grep.',
  'For exact symbols, paths, and references, prefer rg first.',
].join(' ');

process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext: context,
    },
  }),
);
