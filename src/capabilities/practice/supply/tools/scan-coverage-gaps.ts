import { z } from 'zod';
import { EvidenceDemandV1 } from '@/kernel/supply-contracts';
import type { DomainTool } from '@/kernel/tools/types';
import { questionPreparerPendingStock } from '../server/question-preparer-stock';
import { discoverSupplyTargets } from '../server/target-discovery';

const inputSchema = z.object({
  subject_id: z.string().optional(),
  ticket: EvidenceDemandV1.optional(),
});
const outputSchema = z.object({ targets: z.array(z.json()), pending_stock: z.array(z.json()) });
export const scanCoverageGapsTool: DomainTool<
  z.infer<typeof inputSchema>,
  z.infer<typeof outputSchema>
> = {
  name: 'scan_coverage_gaps',
  description: '补题前读覆盖缺口；传 ticket 同时查待准入库存，核实符合用途后扣除，避免重复补题。',
  effect: 'read',
  costClass: 'local',
  mirrorEvent: 'never',
  inputSchema,
  outputSchema,
  async execute(ctx, input) {
    const targets = await discoverSupplyTargets(ctx.db);
    return outputSchema.parse({
      pending_stock: input.ticket ? await questionPreparerPendingStock(ctx.db, input.ticket) : [],
      targets: targets.filter(
        (target) => !input.subject_id || target.subjectId === input.subject_id,
      ),
    });
  },
  summarize(_input, output) {
    return `${output.targets.length} coverage gaps`;
  },
};
