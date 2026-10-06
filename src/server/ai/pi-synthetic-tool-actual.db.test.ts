// YUK-1341 phase A — opencode-go/mimo-v2.6-pro ISOLATED tool-ability proof,
// run BEFORE the providers.ts toolCalling binding flips.
//
// Why this gate exists: the per-model `toolCalling:true` declaration in
// providers.ts is evidence-gated (a sealed actual-output tool-loop run must
// land first), but every PRODUCTION entry point rejects a needsToolCall kind on
// a toolCalling:false lane BEFORE any paid call
// (assertModelProfileCapabilityFit in run-lifecycle.ts). That is exactly the
// bootstrap trap the ticket names: the production harness cannot generate the
// evidence its own admission gate demands. So phase A drives the low-level
// PiAgentAdapter directly — the same execution engine production uses, with
// the same x-opencode-session injection and the same toolCall→toolResult frame
// normalization — against ONE harmless synthetic math tool. No production
// DomainTools, no Exa, no learner data, and providers.ts is NOT touched by
// this run (no capability is advertised before the evidence exists).
//
// Only after this run seals does providers.ts declare
// `models['mimo-v2.6-pro'].capabilities.toolCalling: true`, after which the
// production-entry gate (pi-tool-loop-actual.db.test.ts with
// PI_ACTUAL_MODEL=mimo-v2.6-pro) seals the named binding evidence file
// docs/planning/evidence/2026-09-21-pi-tool-loop-mimo-v2.6-pro-actual.json.
//
// Re-run locally:
//   OPENCODE_API_KEY=sk-... pnpm vitest run --config vitest.db.config.ts \
//     src/server/ai/pi-synthetic-tool-actual.db.test.ts
// Evidence lands in
//   docs/planning/evidence/2026-10-07-yuk1341-synthetic-tool-<model>-actual.json
//   docs/planning/evidence/2026-10-07-yuk1341-synthetic-vision-<model>-actual.json
//
// INERT wherever OPENCODE_API_KEY is unset — CI never carries that key, so the
// describes skip wholesale. Public input is synthetic math / a 1px solid-color
// PNG generated in-test; no learner data crosses the wire. One attempt per
// probe — a failure seals its evidence and is never blindly retried.

import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createId } from '@paralleldrive/cuid2';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { captureGitEvidence } from '../../../tests/helpers/git-evidence';
import type { PreparedExecutionQuery } from './execution-adapter';
import { PiAgentAdapter } from './pi-agent-adapter';
import { type ResolvedProvider, resolveTaskProvider } from './providers';
import type { Options, SDKAssistantMessage, SDKResultMessage, SDKUserMessage } from './sdk-types';
import { piCustomTool } from './tools/pi-tools';

const HAS_KEY = Boolean(process.env.OPENCODE_API_KEY);
const MODEL = process.env.PI_ACTUAL_MODEL ?? 'mimo-v2.6-pro';
const KIND = 'AttributionTask' as const;
const EVIDENCE_DIR = join(process.cwd(), 'docs/planning/evidence');
const TOOL_SERVER = 'yuk1341_probe';
const TOOL_NAME = 'add_numbers';
const TOOL_WIRE_NAME = `mcp__${TOOL_SERVER}__${TOOL_NAME}`;

/** 1×1 solid red PNG — a self-contained vision probe fixture, no external asset. */
const RED_PIXEL_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

function sha256(text: string | Buffer): string {
  return createHash('sha256').update(text).digest('hex');
}

interface ToolCallEffect {
  tool_name: string;
  input_digest: string;
  input_excerpt: string;
  result_text: string;
  is_error: boolean;
}

type Frame = unknown;

function frameType(frame: Frame): string | undefined {
  return (frame as { type?: string } | undefined)?.type;
}

function resultFrameOf(frames: Frame[]): (SDKResultMessage & { source: 'pi' }) | undefined {
  return frames.find((f): f is SDKResultMessage & { source: 'pi' } => frameType(f) === 'result');
}

function finalTextOf(resultFrame: SDKResultMessage | undefined): string {
  return resultFrame && resultFrame.subtype === 'success' ? resultFrame.result : '';
}

function totalCostOf(resultFrame: SDKResultMessage | undefined): number | undefined {
  return (resultFrame as { total_cost_usd?: number } | undefined)?.total_cost_usd;
}

function costEvidence(resultFrame: SDKResultMessage | undefined) {
  const totalCostUsd = totalCostOf(resultFrame);
  if (totalCostUsd !== undefined && Number.isFinite(totalCostUsd)) {
    return {
      basis: 'estimated' as const,
      amount_usd: totalCostUsd,
      ref: `pi-catalog:opencode-go/${MODEL}`,
      note: 'pi usage.cost is the catalog rate-card estimate (design §6 R1), never an invoice',
    };
  }
  return {
    basis: 'unknown' as const,
    amount_usd: null,
    ref: `unpriced:opencode-go/${MODEL}`,
    note: 'no finite pi usage.cost on the terminal frame — recorded as unknown, never 0',
  };
}

async function drain(iterable: AsyncIterable<Frame>): Promise<Frame[]> {
  const out: Frame[] = [];
  for await (const frame of iterable) out.push(frame);
  return out;
}

function resolveLane(): ResolvedProvider {
  return resolveTaskProvider(KIND, { provider: 'opencode-go', model: MODEL });
}

describe.skipIf(!HAS_KEY)('mimo-v2.6-pro synthetic tool-ability proof (YUK-1341 phase A)', () => {
  it('emits and consumes a real tool call through the pi adapter on opencode-go', {
    timeout: 300_000,
  }, async () => {
    const runId = `yuk1341_synth_${createId()}`;
    const prompt =
      `You have exactly one tool available: ${TOOL_WIRE_NAME}. ` +
      'Call it ONCE with a=17 and b=25. Do not compute the sum yourself. ' +
      'After you receive the tool result, reply with ONLY the final number.';
    const effects: ToolCallEffect[] = [];
    const syntheticTool = piCustomTool(
      TOOL_SERVER,
      TOOL_NAME,
      'Add two integers and return their sum as text. Math probe only.',
      { a: z.number().int(), b: z.number().int() },
      async (args) => {
        const sum = Number(args.a) + Number(args.b);
        effects.push({
          tool_name: TOOL_WIRE_NAME,
          input_digest: `sha256:${sha256(JSON.stringify(args))}`,
          input_excerpt: JSON.stringify(args),
          result_text: String(sum),
          is_error: false,
        });
        return { content: [{ type: 'text', text: String(sum) }] };
      },
    );

    const options: Options = {
      model: MODEL,
      systemPrompt:
        'You are a precise calculator. Follow the user instruction exactly: ' +
        'use the provided tool rather than computing mentally.',
      abortController: new AbortController(),
      maxTurns: 4,
      tools: [TOOL_WIRE_NAME],
    };

    let frames: Frame[] = [];
    let runError: { name: string; message: string; stack?: string } | undefined;
    let prepared: PreparedExecutionQuery | undefined;
    try {
      prepared = await new PiAgentAdapter().startup({
        options,
        initializeTimeoutMs: 30_000,
        resolved: resolveLane(),
        runId,
        kind: KIND,
        piToolMounts: [{ type: 'custom', tools: [syntheticTool] }],
      });
      frames = await drain(prepared.query(prompt));
    } catch (err) {
      runError = {
        name: (err as Error).name,
        message: (err as Error).message.slice(0, 600),
        stack: (err as Error).stack?.slice(0, 600),
      };
    } finally {
      await prepared?.close().catch(() => {});
    }

    const assistantFrames = frames.filter(
      (f): f is SDKAssistantMessage & { source: 'pi' } => frameType(f) === 'assistant',
    );
    const observedToolUse: { turn: number; name: string; input: unknown }[] = [];
    assistantFrames.forEach((frame, turn) => {
      const content = (frame.message as { content?: unknown[] }).content ?? [];
      for (const block of content) {
        if ((block as { type?: string }).type === 'tool_use') {
          observedToolUse.push({
            turn,
            name: (block as { name: string }).name,
            input: (block as { input: unknown }).input,
          });
        }
      }
    });
    const toolResultFrames = frames.filter((f) => {
      const content = (f as { message?: { content?: unknown[] } }).message?.content;
      return (
        Array.isArray(content) &&
        content.some((block) => (block as { type?: string }).type === 'tool_result')
      );
    }).length;
    const resultFrame = resultFrameOf(frames);
    const finalText = finalTextOf(resultFrame);
    const usage = (resultFrame as { usage?: unknown } | undefined)?.usage ?? null;

    const evidence = {
      captured_at: new Date().toISOString(),
      ticket: 'YUK-1341',
      phase: 'A-synthetic-tool-ability-pre-binding',
      ...captureGitEvidence(),
      lane: {
        adapter: 'pi',
        provider: 'opencode-go',
        model: MODEL,
        task_kind: KIND,
        run_id: runId,
        session_header: 'x-opencode-session=<run_id>',
        mount: 'piCustomTool (synthetic, TEST-ONLY) — no production DomainTools, no Exa',
        binding_state: 'providers.ts toolCalling NOT yet declared for this model',
      },
      prompt_digest: `sha256:${sha256(prompt)}`,
      prompt_excerpt: prompt.slice(0, 300),
      tool_wire_name: TOOL_WIRE_NAME,
      tool_call_effects: effects,
      observed_tool_use_blocks: observedToolUse,
      tool_result_frames: toolResultFrames,
      assistant_turns: assistantFrames.length,
      terminal: resultFrame
        ? {
            subtype: resultFrame.subtype,
            is_error: resultFrame.is_error,
            num_turns: resultFrame.num_turns,
            stop_reason: resultFrame.stop_reason ?? null,
            output_digest: finalText ? `sha256:${sha256(finalText)}` : null,
            output_excerpt: finalText.slice(0, 300),
          }
        : null,
      usage,
      cost: costEvidence(resultFrame),
      ...(runError ? { error: runError } : {}),
      provenance:
        'PiAgentAdapter (the only post-P4 execution engine) with the default ' +
        'builtinModels()/agentLoop deps — same x-opencode-session injection and ' +
        'toolCall→toolResult frame normalization production uses. The synthetic ' +
        'tool proves the WIRE carries tool calls end-to-end; production capability ' +
        'is declared in providers.ts only after this seal.',
    };
    writeFileSync(
      join(EVIDENCE_DIR, `2026-10-07-yuk1341-synthetic-tool-${MODEL}-actual.json`),
      `${JSON.stringify(evidence, null, 2)}\n`,
    );

    if (runError) throw new Error(`${runError.name}: ${runError.message}`);
    expect(resultFrame?.subtype).toBe('success');
    // The proof itself: the model emitted a tool call AND consumed its result.
    expect(observedToolUse.some((b) => b.name === TOOL_WIRE_NAME)).toBe(true);
    expect(effects.length).toBeGreaterThan(0);
    expect(effects[0].result_text).toBe('42');
    expect(toolResultFrames).toBeGreaterThan(0);
    expect(finalText).toContain('42');
  });

  it('accepts a real image input through the pi adapter (vision wire proof)', {
    timeout: 180_000,
  }, async () => {
    const runId = `yuk1341_vision_${createId()}`;
    const promptText =
      'This is a solid single-color image. Reply with ONLY the dominant color, one word.';
    const userMessage = {
      type: 'user',
      parent_tool_use_id: null,
      message: {
        role: 'user',
        content: [
          { type: 'text', text: promptText },
          {
            type: 'image',
            source: {
              type: 'base64',
              data: RED_PIXEL_PNG_BASE64,
              media_type: 'image/png',
            },
          },
        ],
      },
    } as unknown as SDKUserMessage;

    async function* promptStream(): AsyncGenerator<SDKUserMessage> {
      yield userMessage;
    }

    const options: Options = {
      model: MODEL,
      systemPrompt: 'You answer with a single word.',
      abortController: new AbortController(),
      maxTurns: 2,
      tools: [],
    };

    let frames: Frame[] = [];
    let runError: { name: string; message: string } | undefined;
    let prepared: PreparedExecutionQuery | undefined;
    try {
      prepared = await new PiAgentAdapter().startup({
        options,
        initializeTimeoutMs: 30_000,
        resolved: resolveLane(),
        runId,
        kind: KIND,
      });
      frames = await drain(prepared.query(promptStream()));
    } catch (err) {
      runError = {
        name: (err as Error).name,
        message: (err as Error).message.slice(0, 600),
      };
    } finally {
      await prepared?.close().catch(() => {});
    }

    const resultFrame = resultFrameOf(frames);
    const finalText = finalTextOf(resultFrame);

    const evidence = {
      captured_at: new Date().toISOString(),
      ticket: 'YUK-1341',
      phase: 'A-synthetic-vision-ability-pre-binding',
      ...captureGitEvidence(),
      lane: {
        adapter: 'pi',
        provider: 'opencode-go',
        model: MODEL,
        task_kind: KIND,
        run_id: runId,
        session_header: 'x-opencode-session=<run_id>',
        input_modality: 'text + image/png base64 (1x1 solid red, generated in-test)',
      },
      input_digest: `sha256:${sha256(promptText + RED_PIXEL_PNG_BASE64)}`,
      terminal: resultFrame
        ? {
            subtype: resultFrame.subtype,
            is_error: resultFrame.is_error,
            stop_reason: resultFrame.stop_reason ?? null,
            output_digest: finalText ? `sha256:${sha256(finalText)}` : null,
            output_excerpt: finalText.slice(0, 300),
          }
        : null,
      cost: costEvidence(resultFrame),
      ...(runError ? { error: runError } : {}),
      provenance:
        'Vision for this lane is declared by the native pi catalog ' +
        '(input: text+image) — no providers.ts vision binding exists or is ' +
        'needed. This probe confirms the wire actually carries an image block.',
    };
    writeFileSync(
      join(EVIDENCE_DIR, `2026-10-07-yuk1341-synthetic-vision-${MODEL}-actual.json`),
      `${JSON.stringify(evidence, null, 2)}\n`,
    );

    if (runError) throw new Error(`${runError.name}: ${runError.message}`);
    expect(resultFrame?.subtype).toBe('success');
    // A solid red pixel: any honest single-word answer names the color.
    expect(finalText.toLowerCase()).toMatch(/red|红/);
  });
});
