import { eq } from 'drizzle-orm';
import { encodeDraftRef, parseDraftRef } from '@/core/question-draft-ref';
import {
  CUSTOM_ASSET_MAX_BYTES,
  findCustomCodeForbiddenSequence,
} from '@/core/schema/assessment/presentation';
import { DRAFT_DOCUMENT_SCHEMA_VERSION, QuestionDraftDocument } from '@/core/schema/question-draft';
import { learning_session, question_block } from '@/db/schema';
import { ImmutableAssetError, persistImmutableCustomCodeAsset } from '@/kernel/records/asset-store';
import type { ToolContext } from '@/kernel/tools/types';
import { getR2, requireIngestionScope } from './tools/source-tool-support';

type CustomCodeFailure = {
  status:
    | 'rejected_input'
    | 'unsupported_contract'
    | 'conflict'
    | 'skipped:not_found'
    | 'skipped:not_draft';
  issues: { code: string; detail: string }[];
  current_draft_ref?: string;
  current_draft_version?: number;
};

export type CustomCodeWriteResult =
  | CustomCodeFailure
  | {
      status: 'custom_code_saved';
      issues: [];
      asset_id: string;
      digest: string;
      byte_size: number;
      mime: 'text/javascript';
      reused: boolean;
      preview: 'not_run';
      serving: 'withheld';
    };

class CustomCodeAuthorizationError extends Error {
  constructor(readonly result: CustomCodeFailure) {
    super(result.issues[0]?.detail ?? result.status);
  }
}

/** Inert bytes only. Neither persistence nor a valid presentation is preview/admission. */
export async function writeCustomCodeAsset(
  ctx: ToolContext,
  input: { draftRef: string; code: string },
): Promise<CustomCodeWriteResult> {
  const sessionId = requireIngestionScope(ctx);
  const actorRef = ctx.callerActor.ref;
  if (ctx.callerActor.kind !== 'agent' || actorRef !== `ingestion_agent:${sessionId}`) {
    return {
      status: 'rejected_input',
      issues: [{ code: 'custom_code_scope_mismatch', detail: 'requires the scoped R8 actor' }],
    };
  }
  const ref = parseDraftRef(input.draftRef);
  if (
    ref === null ||
    ref.blockId.length === 0 ||
    encodeDraftRef(ref.blockId, ref.version) !== input.draftRef
  ) {
    return {
      status: 'rejected_input',
      issues: [{ code: 'invalid_draft_ref', detail: 'requires a canonical current draft_ref' }],
    };
  }
  const bytes = new TextEncoder().encode(input.code);
  if (bytes.byteLength === 0 || bytes.byteLength > CUSTOM_ASSET_MAX_BYTES) {
    return {
      status: 'rejected_input',
      issues: [{ code: 'custom_code_size_invalid', detail: 'code must be 1..262144 UTF-8 bytes' }],
    };
  }
  const forbidden = findCustomCodeForbiddenSequence(input.code);
  if (forbidden) {
    return {
      status: 'rejected_input',
      issues: [
        {
          code: 'custom_code_forbidden_sequence',
          detail: `code contains ${forbidden.sequence} at character ${forbidden.index}`,
        },
      ],
    };
  }

  try {
    const { row, reused } = await persistImmutableCustomCodeAsset(ctx.db, getR2(), {
      bytes,
      provenance: {
        source_kind: 'custom_block_code',
        ingestion_session_id: sessionId,
        actor_ref: actorRef,
        task_run_id: ctx.logTaskRunId ?? ctx.taskRunId,
      },
      authorize: async (tx) => {
        await ctx.beforeIngestionWrite?.(tx);
        const [session] = await tx
          .select({ type: learning_session.type, status: learning_session.status })
          .from(learning_session)
          .where(eq(learning_session.id, sessionId))
          .limit(1)
          .for('share');
        if (session?.type !== 'ingestion' || session.status !== 'extracting') {
          throw new CustomCodeAuthorizationError({
            status: 'rejected_input',
            issues: [
              { code: 'custom_code_session_inactive', detail: 'R8 session is not extracting' },
            ],
          });
        }
        const [block] = await tx
          .select({
            status: question_block.status,
            version: question_block.version,
            owner: question_block.ingestion_session_id,
            structured: question_block.structured,
          })
          .from(question_block)
          .where(eq(question_block.id, ref.blockId))
          .limit(1)
          .for('share');
        if (!block || block.owner !== `draft:${actorRef}`) {
          throw new CustomCodeAuthorizationError({ status: 'skipped:not_found', issues: [] });
        }
        if (block.status !== 'draft') {
          throw new CustomCodeAuthorizationError({ status: 'skipped:not_draft', issues: [] });
        }
        if (block.version !== ref.version) {
          throw new CustomCodeAuthorizationError({
            status: 'conflict',
            current_draft_ref: encodeDraftRef(ref.blockId, block.version),
            current_draft_version: block.version,
            issues: [
              { code: 'stale_draft_ref', detail: 'code write requires the current own draft' },
            ],
          });
        }
        const raw: unknown = block.structured;
        if (
          raw !== null &&
          typeof raw === 'object' &&
          'schema_version' in raw &&
          raw.schema_version !== DRAFT_DOCUMENT_SCHEMA_VERSION
        ) {
          throw new CustomCodeAuthorizationError({
            status: 'unsupported_contract',
            issues: [{ code: 'unsupported_draft_version', detail: 'requires a v2 R8 draft' }],
          });
        }
        const parsed = QuestionDraftDocument.safeParse(raw);
        if (
          !parsed.success ||
          parsed.data.source?.kind !== 'photo_ingest' ||
          parsed.data.source.ref !== actorRef
        ) {
          throw new CustomCodeAuthorizationError({
            status: 'rejected_input',
            issues: [
              { code: 'invalid_r8_draft', detail: 'requires a valid system-stamped R8 draft' },
            ],
          });
        }
      },
    });
    return {
      status: 'custom_code_saved',
      issues: [],
      asset_id: row.id,
      digest: `sha256:${row.sha256}`,
      byte_size: row.byte_size,
      mime: 'text/javascript',
      reused,
      preview: 'not_run',
      serving: 'withheld',
    };
  } catch (error) {
    if (error instanceof CustomCodeAuthorizationError) return error.result;
    if (error instanceof ImmutableAssetError) {
      return {
        status: error.code === 'immutable_asset_conflict' ? 'conflict' : 'rejected_input',
        issues: [{ code: error.code, detail: error.message }],
      };
    }
    // Unknown DB/commit failures remain tool errors, never a fabricated asset receipt.
    throw error;
  }
}
