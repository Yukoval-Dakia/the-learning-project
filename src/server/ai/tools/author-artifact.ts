// ADR-0033 (YUK-306, lane D) — interactive 学习 artifact: the two copilot
// authoring DomainTools.
//
// D1: 'interactive' is a NEW ArtifactType (semantic kind, format=html) —
// agent-generated interactive content (e.g. 互动式元素周期表), modeled on
// Claude Artifacts: persistent, named, versioned, sandbox-rendered.
// Self-contained and OPAQUE to the note block-tree mesh: body_blocks stays
// null (the tool_quiz precedent), no cross_link / embedded_check / block_refs
// participation. Reference, not practice — no FSRS, tool_state stays null.
//
// D2: the HTML source lives in artifact.attrs (InteractiveArtifactAttrs —
// existing jsonb column, NO new column, audit:schema untouched). Cross-turn
// iteration (v1→v2) reuses the existing artifact.version + history mechanics
// (body-blocks-edit.ts precedent).
//
// D4 (security split): the backend stores the HTML source OPAQUELY. There is
// deliberately NO sanitizer / linter / HTML inspection here — the render-side
// sandbox (the UI slice's sandboxed iframe) owns security. Validation at this
// boundary is the Zod schema only: title required + html size cap.
//
// D6: the copilot generates the HTML ITSELF in conversation (Claude Artifacts
// pattern — the model writes the HTML and passes it as tool input; no separate
// LLM gen task). Both tools are effect='write' (ADR-0033 D6 explicit: 单用户、
// 路由守 scope via the surface allowlist、非破坏性创建), costClass='local',
// mirrorEvent='when_causal' (write_quiz precedent — evidence-first trail).
//
// Rollback / duplication seam (留痕可回滚, ADR-0033): each author/update call
// persists the full HTML 3× — artifact.attrs + event.payload.args (the
// when_causal mirror in mcp-bridge.ts writes FULL untruncated args) +
// tool_call_log.input_json. Rollback for updates rides on the mirror-event
// args chain: the PRIOR author/update event always holds the v(n-1) html.
// Acceptable single-user storage cost — do NOT "optimize away" the mirror args
// payload without replacing this rollback path. archived_at soft-delete covers
// create-side reversibility.
//
// phase-deferred: no per-turn idempotency guard on author_artifact (write-quiz
// .ts:22-26 same stance — a duplicate create is non-destructive; add a guard
// only if real usage shows double-writes).
// phase-deferred: no surfaced URL in the output yet — the render route is the
// UI slice's seam (ADR-0033 D4); the copilot reports title/id in prose for now.
// phase-deferred: cross-conversation REdiscovery of an existing interactive
// artifact (to feed update_artifact) needs a future read tool / the UI slice —
// out of D6 scope; within a conversation the copilot holds the id from the
// author_artifact output.

import { createId } from '@paralleldrive/cuid2';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';

import { INTERACTIVE_HTML_MAX_CHARS, InteractiveArtifactAttrs } from '@/core/schema/business';
import { artifact } from '@/db/schema';
import {
  artifactRowToCreateSnapshot,
  emitArtifactCreateEvent,
} from '@/server/artifacts/create-event';
import type { DomainTool, ToolContext } from './types';

// ---------------------------------------------------------------------------
// author_artifact — create a new interactive artifact (v0).
// ---------------------------------------------------------------------------

const AuthorArtifactInputSchema = z.object({
  // ADR-0032 author-family discriminant. Flat-enum + route-in-execute is the
  // author_question seed-mode precedent (proposal-tools.ts) — future authorable
  // types widen this enum and add a branch in execute; the schema stays a flat
  // ZodObject (mcp-bridge.ts:145 hard-requires `instanceof z.ZodObject`).
  type: z.enum(['interactive']),
  title: z.string().min(1).max(120),
  // Size cap only. NO sanitizer/linter here: the render-side sandbox owns
  // security (ADR-0033 D4) — the backend stores the source opaquely.
  html: z.string().min(1).max(INTERACTIVE_HTML_MAX_CHARS),
  // Topic-discovery tags (化学节点 ↔ 周期表). Deliberately NO existence check:
  // a dangling id degrades discovery, it breaks nothing.
  knowledge_ids: z.array(z.string().min(1)).optional(),
  summary: z.string().max(500).optional(),
});
type AuthorArtifactInput = z.input<typeof AuthorArtifactInputSchema>;

const AuthorArtifactOutputSchema = z.object({
  artifact_id: z.string(),
  type: z.literal('interactive'),
  title: z.string(),
  version: z.number().int(),
  knowledge_ids: z.array(z.string()),
});
type AuthorArtifactOutput = z.infer<typeof AuthorArtifactOutputSchema>;

async function executeAuthorArtifact(
  ctx: ToolContext,
  rawInput: AuthorArtifactInput,
): Promise<AuthorArtifactOutput> {
  const input = AuthorArtifactInputSchema.parse(rawInput);
  // Validation boundary = the Zod schema above. Everything else is stored
  // opaquely (D4 — the render sandbox owns security).

  const now = new Date();
  const artifactId = `art_${createId()}`;
  const knowledgeIds = input.knowledge_ids ?? [];

  // Like ToolState (RL4), attrs is jsonb opaque to audit:schema — this parse
  // is the load-bearing write barrier.
  const attrs = InteractiveArtifactAttrs.parse({
    format: 'html',
    html: input.html,
    ...(input.summary !== undefined ? { summary: input.summary } : {}),
    origin: 'copilot_author_artifact',
  });

  // Row shape follows writeToolQuizArtifact (tool-quiz-core.ts) column-for-
  // column, with the interactive deltas: body_blocks null (opaque invariant),
  // tool_state UNSET → null (reference not practice — no FSRS), attrs payload.
  //
  // YUK-471 W3-C1β — the INSERT now ALSO emits a self-sufficient artifact_create event in the SAME
  // tx (additive double-write, flag OFF). The bare `ctx.db.insert` is wrapped in a transaction so
  // the INSERT + the event are atomic (parseEvent throws on a bad payload → both roll back). The
  // pre-existing mirrorEvent='when_causal' bridge event is LEFT AS-IS (observability/rollback trail,
  // ADR-0033 — minted AFTER execute returns); artifact_create is the fold-source base, distinct
  // from the mirror. Build the snapshot from the RETURNING row so all 22 columns are materialized.
  await ctx.db.transaction(async (tx) => {
    const [insertedArtifact] = await tx
      .insert(artifact)
      .values({
        id: artifactId,
        type: 'interactive',
        title: input.title,
        parent_artifact_id: null,
        knowledge_ids: knowledgeIds,
        intent_source: 'author_artifact',
        source: 'ai_generated',
        source_ref: null,
        body_blocks: null,
        attrs: attrs as never,
        tool_kind: 'author_artifact',
        generation_status: 'ready',
        verification_status: 'not_required',
        generated_by: {
          by: 'ai',
          task_kind: 'author_artifact',
          task_run_id: ctx.taskRunId,
        } as never,
        history: [],
        created_at: now,
        updated_at: now,
        version: 0,
      })
      .returning();
    await emitArtifactCreateEvent(tx, {
      row: artifactRowToCreateSnapshot(insertedArtifact),
      actorKind: 'agent',
      actorRef: ctx.callerActor.ref,
      causedByEventId: ctx.causedByEventId ?? null,
      taskRunId: ctx.taskRunId,
      createdAt: now,
    });
  });

  return {
    artifact_id: artifactId,
    type: 'interactive',
    title: input.title,
    version: 0,
    knowledge_ids: knowledgeIds,
  };
}

export const authorArtifactTool: DomainTool<AuthorArtifactInput, AuthorArtifactOutput> = {
  name: 'author_artifact',
  description:
    'Create a NEW persistent interactive learning artifact (type=interactive) from a complete self-contained HTML document you write yourself (inline CSS/JS, no external network dependencies — it renders inside a sandbox). Use it when the user asks for interactive content (e.g. an interactive periodic table). Provide a clear title; tag knowledge_ids so the artifact is discoverable from those knowledge nodes. Returns the artifact_id — keep it to iterate later via update_artifact. Pure local write, no LLM call.',
  effect: 'write',
  inputSchema: AuthorArtifactInputSchema,
  outputSchema: AuthorArtifactOutputSchema,
  costClass: 'local',
  // Copilot-initiated write — leave an event trail (evidence-first).
  mirrorEvent: 'when_causal',
  execute: executeAuthorArtifact,
  summarize(input, output) {
    return `author_artifact · interactive · ${output.artifact_id} · ${input.title.slice(0, 40)}`;
  },
};

// ---------------------------------------------------------------------------
// update_artifact — replace the HTML of an EXISTING interactive artifact
// (version bump + history append; cross-turn v1→v2 iteration).
// ---------------------------------------------------------------------------

// phase-deferred: html-only on purpose (ADR-0033 D6 — update = version-bump
// HTML iteration). title/summary/knowledge_ids edits are out of D6 scope; widen
// this schema when a real retitle/retag need shows up.
const UpdateArtifactInputSchema = z.object({
  artifact_id: z.string().min(1),
  // Full replacement document (Claude Artifacts pattern — the model rewrites
  // the whole HTML). Same cap + same no-sanitizer stance as author_artifact.
  html: z.string().min(1).max(INTERACTIVE_HTML_MAX_CHARS),
  // Feeds history[].summary_md — the human-readable v1→v2 timeline.
  change_summary: z.string().max(300).optional(),
});
type UpdateArtifactInput = z.input<typeof UpdateArtifactInputSchema>;

const UpdateArtifactOutputSchema = z.object({
  artifact_id: z.string(),
  previous_version: z.number().int(),
  version: z.number().int(),
});
type UpdateArtifactOutput = z.infer<typeof UpdateArtifactOutputSchema>;

async function executeUpdateArtifact(
  ctx: ToolContext,
  rawInput: UpdateArtifactInput,
): Promise<UpdateArtifactOutput> {
  const input = UpdateArtifactInputSchema.parse(rawInput);
  const now = new Date();

  // Version + history mechanics follow body-blocks-edit.ts. Two deliberate
  // deviations for a DomainTool:
  //   - NO writeEvent here: that service is a user-route owner writing its own
  //     event; this tool gets its event via the bridge's mirrorEvent=
  //     'when_causal' (mcp-bridge.ts) — a second event would double-count.
  //     Consequently the history entry omits `event_id` (the mirror-event id is
  //     minted AFTER execute returns); correlation goes via
  //     tool_call_log.mirrored_event_id instead.
  //   - NO caller-supplied expected_version: the in-tx read supplies it and the
  //     `WHERE version =` guard still protects against concurrent writers
  //     (single-user tool — the model shouldn't have to track
  //     version numbers across turns).
  return ctx.db.transaction(async (tx) => {
    const rows = await tx
      .select({
        id: artifact.id,
        type: artifact.type,
        attrs: artifact.attrs,
        history: artifact.history,
        version: artifact.version,
        archived_at: artifact.archived_at,
      })
      .from(artifact)
      .where(eq(artifact.id, input.artifact_id))
      .limit(1);
    const row = rows[0];
    if (!row) {
      throw new Error(`update_artifact: artifact ${input.artifact_id} does not exist`);
    }
    if (row.archived_at) {
      throw new Error(`update_artifact: artifact ${input.artifact_id} is archived`);
    }
    if (row.type !== 'interactive') {
      throw new Error(
        `update_artifact: artifact ${input.artifact_id} has type '${row.type}' — only type='interactive' artifacts can be updated by this tool`,
      );
    }

    // Merge-parse: replace html, preserve summary/origin + any catchall keys.
    const attrs = InteractiveArtifactAttrs.parse({
      ...(row.attrs as Record<string, unknown>),
      html: input.html,
    });

    const nextVersion = row.version + 1;
    const history = Array.isArray(row.history) ? [...row.history] : [];
    history.push({
      version: nextVersion,
      at: now,
      by: { by: 'ai', task_kind: 'update_artifact', task_run_id: ctx.taskRunId },
      summary_md: input.change_summary ?? 'Updated interactive HTML',
      action: 'interactive_html_update',
      previous_artifact_version: row.version,
      next_artifact_version: nextVersion,
    });

    const updated = await tx
      .update(artifact)
      .set({
        attrs: attrs as never,
        history: history as never,
        updated_at: now,
        version: nextVersion,
      })
      .where(and(eq(artifact.id, input.artifact_id), eq(artifact.version, row.version)))
      .returning({ version: artifact.version });
    if (updated.length === 0) {
      throw new Error(`update_artifact: artifact ${input.artifact_id} concurrently modified`);
    }

    return {
      artifact_id: input.artifact_id,
      previous_version: row.version,
      version: nextVersion,
    };
  });
}

export const updateArtifactTool: DomainTool<UpdateArtifactInput, UpdateArtifactOutput> = {
  name: 'update_artifact',
  description:
    'Update an EXISTING interactive artifact (created by author_artifact) with a new complete HTML document — pass the FULL replacement html, not a diff. Bumps artifact.version and appends a history entry; pass change_summary so the version timeline stays readable. Only works on type=interactive artifacts. Pure local write, no LLM call.',
  effect: 'write',
  inputSchema: UpdateArtifactInputSchema,
  outputSchema: UpdateArtifactOutputSchema,
  costClass: 'local',
  // Copilot-initiated write — leave an event trail (evidence-first).
  mirrorEvent: 'when_causal',
  execute: executeUpdateArtifact,
  summarize(_input, output) {
    return `update_artifact · ${output.artifact_id} · v${output.previous_version}→v${output.version}`;
  },
};
