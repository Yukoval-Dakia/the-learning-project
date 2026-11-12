// list_pending_proposals — the companion's read of its own undecided proposal
// inbox. Reuses the kernel inbox projection (kind derivation, terminal rates,
// corrections, learner-facing titles) instead of a second SQL projection, so the
// companion sees exactly the rows the inbox shows.

import { z } from 'zod';
import { AiProposalKind } from '@/core/schema/proposal';
import { listProposalInboxPage } from '@/kernel/proposals/inbox';
import { proposalDisplayTitle } from '@/kernel/proposals/presentation';
import { TOOL_COURTESY_DEFAULTS } from '@/kernel/tools/budgets';
import type { DomainTool, ToolContext } from '@/kernel/tools/types';

const InputSchema = z.object({
  kind: AiProposalKind.optional(),
  limit: z.number().int().min(1).max(50).optional(),
});

const ProposalRowSchema = z.object({
  id: z.string(),
  kind: z.string(),
  title: z.string(),
  created_at: z.string(),
});

const OutputSchema = z.object({
  proposals: z.array(ProposalRowSchema),
  filter_applied: z.object({
    kind: z.string().nullable(),
    limit: z.number().int(),
  }),
  coverage: z.object({
    returned_count: z.number().int().nonnegative(),
    limit: z.number().int().positive(),
    /** More matching pending rows exist beyond this page. */
    has_more: z.boolean(),
  }),
  claim_boundaries: z.object({
    // Rows with an unparseable or legacy-unknown payload are dropped by the
    // projection, so an empty page cannot prove the inbox is empty.
    zero_rows_scope: z.literal('matching_pending_proposal_rows_only'),
    supports_entity_inventory_claim: z.literal(false),
    supports_lifecycle_status_count_claim: z.literal(false),
  }),
});

type Input = z.infer<typeof InputSchema>;
type Output = z.infer<typeof OutputSchema>;

const DESCRIPTION = [
  'List the proposals still waiting for a decision: id, kind, title, created_at.',
  'Use it before proposing or when the learner asks what awaits confirmation.',
  'Optional kind narrows to one kind; limit is 1–50 (default 20).',
  'Pending page only, never an all-status inventory: decided and dismissed proposals are',
  'absent and unparseable stored payloads are skipped, so zero rows mean no matching',
  'pending rows were projected.',
].join('\n');

async function execute(ctx: ToolContext, raw: Input): Promise<Output> {
  const input = InputSchema.parse(raw);
  const limit = input.limit ?? TOOL_COURTESY_DEFAULTS.list_pending_proposals;
  const page = await listProposalInboxPage(ctx.db, {
    status: 'pending',
    limit,
    ...(input.kind ? { kind: input.kind } : {}),
  });
  return OutputSchema.parse({
    proposals: page.rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      // `presentation.title` already exists on the row; the pure presenter is
      // the same owner function, used only if presentation enrichment degraded.
      title: row.presentation?.title ?? proposalDisplayTitle(row.payload),
      created_at: row.proposed_at.toISOString(),
    })),
    filter_applied: { kind: input.kind ?? null, limit },
    coverage: {
      returned_count: page.rows.length,
      limit,
      has_more: page.next_cursor !== null,
    },
    claim_boundaries: {
      zero_rows_scope: 'matching_pending_proposal_rows_only',
      supports_entity_inventory_claim: false,
      supports_lifecycle_status_count_claim: false,
    },
  });
}

function summarize(input: Input, output: Output): string {
  const parts: string[] = [`${output.coverage.returned_count} pending`];
  if (input.kind) parts.push(`kind=${input.kind}`);
  if (output.coverage.has_more) parts.push('more');
  return `proposals · ${parts.join(' · ')}`;
}

export const listPendingProposalsTool: DomainTool<Input, Output> = {
  name: 'list_pending_proposals',
  description: DESCRIPTION,
  effect: 'read',
  inputSchema: InputSchema,
  outputSchema: OutputSchema,
  costClass: 'local',
  execute,
  summarize,
  mirrorEvent: 'when_user_visible',
};
