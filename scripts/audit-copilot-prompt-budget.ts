/**
 * audit:copilot-prompt-budget — the learner-facing Copilot system prompt must
 * stay within the owner's 12,000-character budget (Owner 2026-11-05), skill
 * packs included.
 *
 * It measures the REAL assembly path, not a hand-copied string:
 *   base    getTaskSystemPrompt('CopilotTask', ...) — the same call
 *           buildQueryOptions() makes for every ai run (src/server/ai/runner.ts).
 *   skills  resolveCopilotSkillDocs() — the resolver copilot-execution.ts
 *           injects as piSkillDocs.
 *   append  composePiSystemPrompt() — the exact function pi-agent-adapter.ts
 *           uses to append <skill> bodies to the system prompt.
 *
 * Fixed inputs: the neutral `general` subject profile and the zh-CN learner
 * locale. Dynamic per-turn text is NOT part of the system prompt, so it is not
 * counted: conversation_history, the role:"context" startup segment,
 * proposal_feedback, ambient_context and the answer-only prefix (compiled into
 * the user message), plus tool JSON schemas (mounted in pi's tools array).
 *
 * Characters = JS String.length (UTF-16 code units).
 *
 * Exit 1 when the total exceeds the budget, or when the assembly anchors no
 * longer match (that means this audit can no longer see the real prompt).
 * No DB, network, or provider calls.
 */

process.env.DATABASE_URL ??= 'postgresql://audit:unused@127.0.0.1:1/audit?sslmode=disable';

import { fileURLToPath } from 'node:url';

/** Owner 2026-11-05 budget: 学伴 system prompt (skills included) ≤ 12,000 chars. */
const OWNER_PROMPT_BUDGET_CHARS = 12_000;

const SECTION_HEADINGS = [
  '【一、你要做什么】',
  '【二、身份和做事方式】',
  '【三、怎么和学习者说话】',
  '【四、你所在的环境和工具】',
] as const;

interface Segment {
  label: string;
  chars: number;
}

function formatChars(value: number): string {
  return value.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function splitBasePrompt(base: string, localePin: string): Segment[] {
  if (!base.endsWith(localePin)) {
    throw new Error('base prompt does not end with LEARNER_LOCALE_PIN — audit anchors are stale');
  }
  const core = base.slice(0, -localePin.length);
  const offsets = SECTION_HEADINGS.map((heading) => {
    const index = core.indexOf(heading);
    if (index < 0) throw new Error(`prompt section heading missing: ${heading}`);
    return index;
  });
  for (let i = 1; i < offsets.length; i += 1) {
    if (offsets[i] <= offsets[i - 1]) {
      throw new Error(`prompt section order changed near: ${SECTION_HEADINGS[i]}`);
    }
  }

  const segments: Segment[] = SECTION_HEADINGS.map((heading, i) => ({
    label: heading.slice(1, -1),
    chars: (i + 1 < offsets.length ? offsets[i + 1] : core.length) - offsets[i],
  }));
  segments.push({ label: '输出语言 pin', chars: localePin.length });
  return segments;
}

async function main(): Promise<void> {
  const { getTaskSystemPrompt, LEARNER_LOCALE_PIN } = await import('@/capabilities/task-registry');
  const { resolveCopilotSkillDocs } = await import('@/subjects/copilot-skills');
  const { resolveSubjectProfile } = await import('@/subjects/profile');
  const { composePiSystemPrompt } = await import('@/server/ai/pi-system-prompt');

  const skillsRoot = fileURLToPath(new URL('../src/subjects', import.meta.url));
  const base = getTaskSystemPrompt('CopilotTask', resolveSubjectProfile(), 'zh-CN');
  const skillDocs = await resolveCopilotSkillDocs(skillsRoot);
  if (!skillDocs || skillDocs.length === 0) {
    throw new Error(
      `no copilot skill packs resolved under ${skillsRoot} — cannot measure the real assembled prompt`,
    );
  }

  const segments = splitBasePrompt(base, LEARNER_LOCALE_PIN);
  // Compose one doc at a time with the runtime function so each skill segment
  // includes its <skill> wrapper and the separators; the segments sum to TOTAL.
  let composed = base;
  for (const doc of skillDocs) {
    const next = composePiSystemPrompt(composed, [doc]);
    segments.push({ label: `技能包 ${doc.name}`, chars: next.length - composed.length });
    composed = next;
  }

  const total = composed.length;
  const overBudget = total > OWNER_PROMPT_BUDGET_CHARS;
  const delta = total - OWNER_PROMPT_BUDGET_CHARS;

  console.log(
    'audit:copilot-prompt-budget — 学伴 system prompt 字符预算（Owner 2026-11-05：≤ 12,000）\n',
  );
  console.log('  组装来源（运行期同一段代码）:');
  console.log(
    "    - 基础提示 getTaskSystemPrompt('CopilotTask', general, zh-CN) — src/ai/task-prompts.ts",
  );
  console.log(
    '    - 技能正文 resolveCopilotSkillDocs(src/subjects) — src/subjects/copilot-skills.ts',
  );
  console.log(
    '    - 拼接 composePiSystemPrompt() — src/server/ai/pi-system-prompt.ts（pi-agent-adapter 同一函数）',
  );
  console.log('\n  各段字符数（字符 = JS String.length）:');
  for (const segment of segments) {
    console.log(`    - ${segment.label}：${formatChars(segment.chars)}`);
  }
  console.log(`\n  合计：${formatChars(total)} / 预算 ${formatChars(OWNER_PROMPT_BUDGET_CHARS)}`);
  console.log(
    overBudget
      ? `  结果：FAIL（超 ${formatChars(delta)} 字符）`
      : `  结果：PASS（余量 ${formatChars(-delta)} 字符）`,
  );
  console.log(
    '\n  未计入（不属于 system prompt）：conversation_history、role:"context" 启动段、' +
      'proposal_feedback、ambient_context、answer_only 前缀、工具 JSON Schema。',
  );

  if (overBudget) process.exit(1);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
