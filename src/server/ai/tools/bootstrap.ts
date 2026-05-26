// YUK-80 / Foundation D M1 Lane B
//
// Bootstrap: register all known DomainTools into the module-level registry.
// Callers (debug endpoint, future MCP bridge in Lane C) invoke this once at
// request entry. The function is idempotent — if a tool is already present it
// is skipped, so re-imports across Next.js HMR cycles don't trip the
// registerTool duplicate guard.

import { queryMistakesTool } from './query-mistakes';
import { getTool, registerTool } from './registry';
import type { DomainTool } from './types';

const CORE_TOOLS: ReadonlyArray<DomainTool<unknown, unknown>> = [
  queryMistakesTool as DomainTool<unknown, unknown>,
];

let bootstrapped = false;

export function registerCoreTools(): void {
  if (bootstrapped) return;
  for (const tool of CORE_TOOLS) {
    if (!getTool(tool.name)) {
      registerTool(tool);
    }
  }
  bootstrapped = true;
}

/** Test-only: reset bootstrap latch so tests can re-register after __resetRegistryForTests(). */
export function __resetBootstrapForTests(): void {
  bootstrapped = false;
}
