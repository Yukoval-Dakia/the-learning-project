// YUK-328 — composition-root aggregator for `copilotTools` contributions.
//
// The truth source is each manifest's `copilotTools` (the name is historical; it
// now covers the full DomainTool inventory). Surface permissions stay in
// allowlists.ts, and the bridge only consumes tools registered here.
// The `as DomainTool` narrowing lives in this one place: kernel's CopilotToolDecl
// loads a minimal { name } shape so kernel does not depend on src/server types.

import type { CapabilityManifest } from '@/kernel/manifest';

import type { DomainTool } from '@/kernel/tools/types';
import { getTool, registerTool } from './registry';

export async function registerCapabilityTools(
  capabilities: readonly CapabilityManifest[],
): Promise<void> {
  const decls = capabilities
    .flatMap((cap) => cap.copilotTools?.tools ?? [])
    .filter((decl) => decl.load);
  for (const decl of decls) {
    // Kept for TS narrowing (callers already filtered on load).
    if (!decl.load) continue;
    if (getTool(decl.name)) continue;
    const tool = (await decl.load()) as DomainTool<unknown, unknown>;
    // Re-check after the await: the gap between getTool and registerTool is a
    // registration point, so a concurrent aggregator may have registered the name.
    if (getTool(decl.name)) continue;
    if (tool.name !== decl.name) {
      throw new Error(
        `registerCapabilityTools: manifest declares '${decl.name}' but module exports '${tool.name}'`,
      );
    }
    registerTool(tool);
  }
}
