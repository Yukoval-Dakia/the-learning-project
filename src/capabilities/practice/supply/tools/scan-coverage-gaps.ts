import { z } from 'zod';
import type { DomainTool } from '@/kernel/tools/types';
import { discoverSupplyTargets } from '../server/target-discovery';

const inputSchema = z.object({ subject_id: z.string().optional() });
const outputSchema = z.object({ targets: z.array(z.json()) });
export const scanCoverageGapsTool: DomainTool<
  z.infer<typeof inputSchema>,
  z.infer<typeof outputSchema>
> = {
  name: 'scan_coverage_gaps',
  description: '补题前读取当前覆盖缺口信号；只扫描，不派任务、不写库。',
  effect: 'read',
  costClass: 'local',
  mirrorEvent: 'never',
  inputSchema,
  outputSchema,
  async execute(ctx, input) {
    const targets = await discoverSupplyTargets(ctx.db);
    return outputSchema.parse({
      targets: targets.filter(
        (target) => !input.subject_id || target.subjectId === input.subject_id,
      ),
    });
  },
  summarize(_input, output) {
    return `${output.targets.length} coverage gaps`;
  },
};
