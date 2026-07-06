// YUK-572 PR-1 — evidence-scout AgentDefinition assembly pin. Pure, no DB.
//
// These assertions are the anti-swarm STRUCTURAL guard (spec §9): the scout can read
// evidence + report findings, but can NEVER spawn (Task) or propose (director write
// tools). The `tools` key must be an explicit array — its very presence is the red
// line (omitting it = inherit-all = isolation break, Lens A #1).

import { describe, expect, it } from 'vitest';
import { buildEvidenceScoutAgentDefinition } from './scout-agent';
import {
  DIRECTOR_WRITE_TOOL_NAMES,
  EVIDENCE_READ_TOOL_NAMES,
  GET_TRACES_TOOL_NAME,
  REPORT_FINDINGS_TOOL_NAME,
  SPAWN_TOOL_NAME,
} from './tool-names';

const PROMPT = 'you are the deep-dive scout ... report_findings';

describe('buildEvidenceScoutAgentDefinition', () => {
  it('threads the injected prompt + description through', () => {
    const def = buildEvidenceScoutAgentDefinition({ prompt: PROMPT });
    expect(def.prompt).toBe(PROMPT);
    expect(typeof def.description).toBe('string');
    expect(def.description.length).toBeGreaterThan(0);

    const custom = buildEvidenceScoutAgentDefinition({ prompt: PROMPT, description: 'x' });
    expect(custom.description).toBe('x');
  });

  it('EXPLICITLY enumerates tools = 6 read + report_findings (never omitted)', () => {
    const def = buildEvidenceScoutAgentDefinition({ prompt: PROMPT });
    // The key must be present (undefined ⇒ inherit-all ⇒ isolation break).
    expect(def.tools).toBeDefined();
    expect(Array.isArray(def.tools)).toBe(true);
    expect(def.tools).toEqual([...EVIDENCE_READ_TOOL_NAMES, REPORT_FINDINGS_TOOL_NAME]);
    expect(def.tools).toHaveLength(7);
  });

  it('does NOT grant Task, director write tools, or get_traces in tools', () => {
    const def = buildEvidenceScoutAgentDefinition({ prompt: PROMPT });
    const tools = def.tools ?? [];
    expect(tools).not.toContain(SPAWN_TOOL_NAME);
    expect(tools).not.toContain(GET_TRACES_TOOL_NAME);
    for (const w of DIRECTOR_WRITE_TOOL_NAMES) expect(tools).not.toContain(w);
  });

  it('disallowedTools double-locks Task + both director write tools', () => {
    const def = buildEvidenceScoutAgentDefinition({ prompt: PROMPT });
    const disallowed = def.disallowedTools ?? [];
    expect(disallowed).toContain(SPAWN_TOOL_NAME);
    for (const w of DIRECTOR_WRITE_TOOL_NAMES) expect(disallowed).toContain(w);
  });

  it('references the research_evidence server by name and caps maxTurns at 12', () => {
    const def = buildEvidenceScoutAgentDefinition({ prompt: PROMPT });
    expect(def.mcpServers).toEqual(['research_evidence']);
    expect(def.maxTurns).toBe(12);
  });

  it('leaves model unset (inherit main thread)', () => {
    const def = buildEvidenceScoutAgentDefinition({ prompt: PROMPT });
    expect(def.model).toBeUndefined();
  });
});
