// YUK-1548 (D2/§4) — compose_block, the ONE mandatory write path for every
// generative-UI block. validate → typed issues (repair loop) → write-once
// content-addressed assets → `![alt](block:<ref>)` placement, substituted into
// canonical tlp-block fences at commit. mirrorEvent 'never' (R11): the asset
// is the record; large svg/html args stay out of mirrors and logs.

import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { compilePlotBlock } from '@/core/blocks/scene/plot';
import {
  BLOCK_IMPLEMENTED_KINDS,
  BLOCK_REF_SCHEME,
  BLOCK_SURFACE_KINDS,
  BlockInputV1,
  type BlockIssueT,
  type BlockKind,
  type BlockSurface,
  type BlockV1T,
  canonicalBlockJson,
} from '@/core/schema/blocks';
import { tool_call_log } from '@/db/schema';
import { chartSeriesIssues, isJsonPointer } from '@/kernel/blocks/chart';
import { blockDigest, blockRefForDigest } from '@/kernel/blocks/digest';
import { lintMermaidSource } from '@/kernel/blocks/mermaid-lint';
import { parseMermaidSource } from '@/kernel/blocks/mermaid-validate';
import { rebuildSvgFigure } from '@/kernel/blocks/svg-rebuild';
import { getR2 } from '@/kernel/object-storage';
import { isKnowledgeCardVisible } from '@/kernel/read-models/knowledge-card';
import { isNoteCardVisible } from '@/kernel/read-models/note-card';
import { readQuestionCard } from '@/kernel/read-models/question-card';
import { createAssessmentAssetLoader } from '@/kernel/records/assessment-assets';
import { ImmutableAssetError, persistImmutableAsset } from '@/kernel/records/asset-store';
import { drawingRequestPort } from '@/kernel/tools/drawing-request';
import type { DomainTool, ToolContext, ToolImageOutput } from '@/kernel/tools/types';

const BLOCK_CANONICAL_MAX_BYTES = 64 * 1024;
const BLOCKS_PER_REPLY_MAX = 12;

const ComposeBlockInput = z
  .object({
    block: BlockInputV1,
    /** question_material callers carry their own draft ref (slice 3). */
    draft_ref: z.string().min(1).optional(),
  })
  .strict();
type ComposeBlockInputT = z.infer<typeof ComposeBlockInput>;

const BlockIssueSchema = z
  .object({
    code: z.string().min(1),
    path: z.string(),
    detail: z.string(),
    line: z.number().int().min(1).optional(),
    column: z.number().int().min(1).optional(),
    expected: z.array(z.string()).max(12).optional(),
  })
  .strict();

const ComposeBlockOutput = z.object({
  status: z.enum(['ready', 'invalid', 'unavailable']),
  ref: z.string().optional(),
  kind: z.string().optional(),
  digest: z.string().optional(),
  block: z.unknown().optional(),
  place: z.string().optional(),
  issues: z.array(BlockIssueSchema).optional(),
  images: z
    .array(
      z
        .object({
          ref: z.object({ asset_id: z.string(), digest: z.string() }).strict(),
          max_edge: z.number().optional(),
        })
        .strict(),
    )
    .optional(),
});
type ComposeBlockOutputT = z.infer<typeof ComposeBlockOutput>;

function invalid(issues: BlockIssueT[]): ComposeBlockOutputT {
  return { status: 'invalid', issues };
}

function shapeIssue(path: string, detail: string): BlockIssueT {
  return { code: 'shape_invalid', path, detail };
}

async function readyBlocksThisRun(ctx: ToolContext, inlineOnly = false): Promise<number> {
  const taskRunId = ctx.logTaskRunId ?? ctx.taskRunId;
  const rows = await ctx.db
    .select({ output: tool_call_log.output_json })
    .from(tool_call_log)
    .where(
      and(eq(tool_call_log.task_run_id, taskRunId), eq(tool_call_log.tool_name, 'compose_block')),
    );
  return rows.filter((row) => {
    const output = row.output as {
      status?: string;
      block?: { kind?: string; display?: string };
    } | null;
    return (
      output?.status === 'ready' &&
      (!inlineOnly || (output.block?.kind === 'question_ref' && output.block.display === 'inline'))
    );
  }).length;
}

async function validateDiagram(input: { source: string }): Promise<{ issues: BlockIssueT[] }> {
  const lintIssues = lintMermaidSource(input.source);
  if (lintIssues.length > 0) return { issues: lintIssues.slice(0, 12) };
  return { issues: await parseMermaidSource(input.source) };
}

async function composeFigureAsset(
  ctx: ToolContext,
  svg: string,
): Promise<
  | { ok: true; asset: { asset_id: string; digest: string }; images: ToolImageOutput[] }
  | { ok: false; issues: BlockIssueT[] }
> {
  const rebuilt = rebuildSvgFigure(svg);
  if (!rebuilt.ok) return { ok: false, issues: rebuilt.issues };
  try {
    const { row } = await persistImmutableAsset(ctx.db, getR2(), {
      profile: 'svg_figure',
      bytes: new TextEncoder().encode(rebuilt.svg),
      provenance: {
        source_kind: 'svg_figure',
        actor_ref: ctx.callerActor.ref,
        task_run_id: ctx.logTaskRunId ?? ctx.taskRunId,
      },
      authorize: async () => {},
    });
    const digest = `sha256:${row.sha256}`;
    return {
      ok: true,
      asset: { asset_id: row.id, digest },
      images: [{ ref: { asset_id: row.id, digest } }],
    };
  } catch (error) {
    if (error instanceof ImmutableAssetError) {
      return {
        ok: false,
        issues: [{ code: 'svg_parse_error', path: '/svg', detail: error.message }],
      };
    }
    throw error;
  }
}

async function verifyFigureAssetRef(
  ctx: ToolContext,
  asset: { asset_id: string; digest: string },
): Promise<BlockIssueT | null> {
  const loader = createAssessmentAssetLoader(ctx.db, (key) => getR2().get(key));
  const loaded = await loader(
    { asset_id: asset.asset_id, digest: asset.digest } as never,
    ctx.signal ?? new AbortController().signal,
  );
  if (loaded === null || loaded.mime_type !== 'image/svg+xml') {
    return {
      code: 'shape_invalid',
      path: '/asset',
      detail: 'the figure asset ref does not resolve to a stored svg_figure; resubmit with svg',
    };
  }
  return null;
}

/**
 * The surface is bound at mount time by the capability that registers the
 * tool — never derived from the caller ref or the input. Each surface owns
 * its own registered instance.
 */
export function createComposeBlockTool(
  surface: BlockSurface,
): DomainTool<ComposeBlockInputT, ComposeBlockOutputT> {
  return {
    name: 'compose_block',
    description:
      'Compose one generative-UI block for the reply. Mandatory channel for diagrams, figures, charts and function plots — never write tlp-block fences yourself. Pass one block object; invalid input returns typed issues (code/path/line/expected) to repair and resubmit. On ready, place the block in prose with the returned place string `![alt](block:ref)`. A figure returns its raster under images for visual self-check before you cite it. A chart binds to recorded data with data_source.kind="tool_result" (tool_use_id + JSON Pointer path); the server replaces your series with those recorded values.',
    effect: 'write',
    inputSchema: ComposeBlockInput,
    outputSchema: ComposeBlockOutput,
    costClass: 'local',
    mirrorEvent: 'never',
    async execute(ctx, input): Promise<ComposeBlockOutputT> {
      const parsed = BlockInputV1.safeParse(input.block);
      if (!parsed.success) {
        return invalid(
          parsed.error.issues.slice(0, 12).map((issue) => ({
            code: 'shape_invalid',
            path: `/${issue.path.join('/')}`,
            detail: issue.message,
          })),
        );
      }
      const block = parsed.data;
      if (!BLOCK_SURFACE_KINDS[surface].includes(block.kind)) {
        return invalid([
          {
            code: 'kind_not_allowed_on_surface',
            path: '/kind',
            detail: `kind '${block.kind}' is not allowed on the '${surface}' surface`,
            expected: [...BLOCK_SURFACE_KINDS[surface]],
          },
        ]);
      }
      if (!BLOCK_IMPLEMENTED_KINDS.includes(block.kind)) {
        return invalid([
          {
            code: 'kind_not_allowed_on_surface',
            path: '/kind',
            detail: `kind '${block.kind}' is not supported by this build yet`,
            expected: [...BLOCK_IMPLEMENTED_KINDS],
          },
        ]);
      }
      if ((await readyBlocksThisRun(ctx)) >= BLOCKS_PER_REPLY_MAX) {
        return {
          status: 'unavailable',
          issues: [
            {
              code: 'block_limit_exceeded',
              path: '',
              detail: `a reply carries at most ${BLOCKS_PER_REPLY_MAX} ready blocks`,
            },
          ],
        };
      }

      let stored: BlockV1T;
      let images: ToolImageOutput[] | undefined;
      switch (block.kind) {
        case 'question_ref': {
          if (block.alt !== '题目' || block.label !== '打开题目' || block.caption !== undefined) {
            return invalid([
              {
                code: 'block_text_reveals_key',
                path: '',
                detail:
                  'question references carry ids only: alt must be 题目, label must be 打开题目, and caption must be absent',
              },
            ]);
          }
          if (block.display === 'inline' && block.question_ids.length !== 1) {
            return invalid([
              shapeIssue('/question_ids', 'inline requires exactly one question id'),
            ]);
          }
          if (block.display === 'inline' && (await readyBlocksThisRun(ctx, true)) >= 3) {
            return invalid([
              {
                code: 'block_limit_exceeded',
                path: '',
                detail:
                  'a reply carries at most three inline question references; use display: "link" for the remaining questions',
              },
            ]);
          }
          for (const [index, id] of block.question_ids.entries()) {
            const card = await readQuestionCard(ctx.db, id);
            if (card.question === null) {
              return invalid([
                {
                  code: 'question_ref_not_servable',
                  path: `/question_ids/${index}`,
                  detail:
                    'question must exist, be visible and not withdrawn; only admission-owned questions may be shown while checking',
                },
              ]);
            }
          }
          stored = block;
          break;
        }
        case 'entity_card': {
          const expectedAlt = block.entity_kind === 'knowledge' ? '知识点' : '笔记';
          if (block.alt !== expectedAlt || block.label !== '打开' || block.caption !== undefined) {
            return invalid([
              {
                code: 'block_text_reveals_key',
                path: '',
                detail:
                  'entity cards carry ids only: alt must match entity_kind (知识点 or 笔记), label must be 打开, and caption must be absent',
              },
            ]);
          }
          // One visibility answer for both missing and hidden targets so the tool
          // result reveals no difference.
          const visible =
            block.entity_kind === 'knowledge'
              ? await isKnowledgeCardVisible(ctx.db, block.entity_id)
              : await isNoteCardVisible(ctx.db, block.entity_id);
          if (!visible) {
            return invalid([
              {
                code: 'entity_card_not_servable',
                path: '/entity_id',
                detail: 'entity must exist and be visible; knowledge-point and note ids only',
              },
            ]);
          }
          stored = block;
          break;
        }
        case 'plot': {
          const compiled = compilePlotBlock(block, surface);
          if (!compiled.ok) return invalid([...compiled.issues]);
          stored = compiled.block;
          break;
        }
        case 'chart': {
          // Only the chat surface is wired in this slice; the note and
          // question_material allowlists are declared for later surfaces but
          // have no compose instance yet.
          if (surface !== 'chat') {
            return invalid([
              {
                code: 'kind_not_allowed_on_surface',
                path: '/kind',
                detail: `kind 'chart' is not wired for the '${surface}' surface`,
              },
            ]);
          }
          const issues = chartSeriesIssues(block);
          if (issues.length > 0) return invalid(issues);
          if (block.data_source.kind === 'tool_result' && !isJsonPointer(block.data_source.path)) {
            return invalid([
              {
                code: 'chart_tool_result_unresolved',
                path: '/data_source/path',
                detail: 'path must be a JSON Pointer such as /mistakes/0/count',
              },
            ]);
          }
          stored = block;
          break;
        }
        case 'drawing': {
          // The dedicated lane draws in the background; the stored block is
          // the drawing pointer and the reply gets its placeholder immediately.
          const request = drawingRequestPort();
          const outcome = await request(
            {
              db: ctx.db,
              sessionId: ctx.sessionId,
              taskRunId: ctx.logTaskRunId ?? ctx.taskRunId,
              ...(ctx.causedByEventId !== undefined
                ? { causedByEventId: ctx.causedByEventId }
                : {}),
              actorRef: ctx.callerActor.ref,
              ...(ctx.sourceLedger !== undefined ? { ledger: ctx.sourceLedger } : {}),
              ...(ctx.answerOnly !== undefined ? { answerOnly: ctx.answerOnly } : {}),
            },
            {
              brief: block.brief,
              alt: block.alt,
              ...(block.caption !== undefined ? { caption: block.caption } : {}),
            },
          );
          if (outcome.status !== 'ready') {
            return { status: 'unavailable', issues: outcome.issues };
          }
          // The learner-visible block is a pointer only — the brief stays
          // server-side on the drawing row (it may quote source content the
          // learner has not been judged on yet).
          stored = {
            v: block.v,
            kind: 'drawing',
            alt: block.alt,
            ...(block.caption !== undefined ? { caption: block.caption } : {}),
            drawing_id: outcome.drawing_id,
          };
          break;
        }
        case 'diagram': {
          const { issues } = await validateDiagram(block);
          if (issues.length > 0) return invalid(issues);
          stored = block;
          break;
        }
        case 'figure': {
          if (block.svg != null && block.asset != null) {
            return invalid([shapeIssue('/svg', 'exactly one of svg / asset is required')]);
          }
          if (block.svg == null && block.asset == null) {
            return invalid([shapeIssue('/svg', 'exactly one of svg / asset is required')]);
          }
          if (block.svg != null) {
            const composed = await composeFigureAsset(ctx, block.svg);
            if (!composed.ok) return invalid(composed.issues);
            const { svg: _svg, ...rest } = block;
            stored = { ...rest, asset: composed.asset };
            images = composed.images;
          } else {
            const assetIssue = await verifyFigureAssetRef(
              ctx,
              block.asset as {
                asset_id: string;
                digest: string;
              },
            );
            if (assetIssue) return invalid([assetIssue]);
            const { svg: _svg, ...rest } = block;
            stored = { ...rest, asset: block.asset } as BlockV1T;
          }
          break;
        }
        default:
          return invalid([
            {
              code: 'kind_not_allowed_on_surface',
              path: '/kind',
              detail: `kind '${(block as { kind: string }).kind}' is not handled`,
            },
          ]);
      }

      const canonicalBytes = new TextEncoder().encode(canonicalBlockJson(stored)).byteLength;
      if (canonicalBytes > BLOCK_CANONICAL_MAX_BYTES) {
        return invalid([
          { code: 'too_large', path: '', detail: 'canonical block JSON exceeds 64 KiB' },
        ]);
      }
      const digest = blockDigest(stored);
      const ref = blockRefForDigest(digest);
      return {
        status: 'ready',
        ref,
        kind: stored.kind as BlockKind,
        digest,
        block: stored,
        place: `![${stored.alt}](${BLOCK_REF_SCHEME}${ref})`,
        ...(images ? { images } : {}),
      };
    },
    summarize(input, output) {
      const kind = (input.block as { kind?: string } | undefined)?.kind ?? '?';
      const codes = output.issues?.map((issue) => issue.code).join(',');
      return `compose_block ${kind}: ${output.status}${codes ? ` (${codes})` : ''}`;
    },
  };
}

/** Copilot chat surface instance (the only surface in slice 1). */
export const composeBlockTool = createComposeBlockTool('chat');
