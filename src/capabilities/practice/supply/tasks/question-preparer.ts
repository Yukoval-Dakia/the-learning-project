import { z } from 'zod';
import { DEFAULT_TASK_BUDGET, type TaskSpec } from '@/ai/task-spec';
import { parseTaskOutput } from '@/kernel/parse-task-output';

const report = z.object({ outcome: z.enum(['done', 'no_progress']), summary: z.string() });
export const questionPreparerTaskSpec = {
  ownership: 'owned',
  definition: {
    kind: 'QuestionPreparerTask',
    description: 'Prepare questions for one gap; repair synchronous issues and admission returns.',
    defaultProvider: 'opencode-go',
    defaultModel: 'deepseek-v4.1-flash',
    budget: {
      ...DEFAULT_TASK_BUDGET,
      maxIterations: 6,
      maxCost: Number.MAX_SAFE_INTEGER,
      timeout: 1_200_000,
    },
    enforceMaxCost: true,
    needsToolCall: true,
    isMultimodal: false,
    allowedTools: [],
    context: { view: 'none', reason: '缺口单和显式证据工具提供本次备题上下文' },
    prompt: {
      kind: 'inline',
      text: `你是备题员。处理一张 gap_ticket，只看题目质量，自己决定查库、外找或自出；没有固定找题顺序。needed_by 和 steering 是真实用户意图，不能丢弃。
gap_ticket.inventory_goal.eligible_count 是目标题库总量，不是新增数量。先用 search_bank 和 scan_coverage_gaps 看真实库存，按用途/知识点/难度核实可用题 N，只补 max(0,目标总量-N)；已有库存满足目标就停止，不提交新题。绝不沿用旧链固定新增8题。withheld/pending 不是可用库存，但其占用差额必须计入，不能因等待准入而重复补题；scan_coverage_gaps 传原 gap_ticket 为 ticket，返回 pending_stock，先核实范围并扣除这些待准入题。search_bank 没有完整召回不能宣称全库为零，已知可用题用 read_bank/check_bank 核实。query_mistakes 的 user_notes/analysis_md 只作学习者错法证据，绝不复制到题面、选项或参考答案；这是提示层约束。需要时读取知识图谱、read_bank/check_bank，金标只作参考，agent 不能盖 gold。改编须声明 adapted_from_question_id。
外找用 web_fetch_candidates 或 jyeoo_fetch_candidates；菁优只覆盖高中10–12数学且保留外部授权限制。fetch 返回候选不是入库，也不能捏造网址、图或 extraction_hash。候选原样 submit_question；web 必传 source_route:"sourcing_web"，菁优传 "jyeoo_fetch"。改内容走草稿。
自出、改编或拆单元用 edit_question(action=save, document)，随后 submit_question 提交最新 draft_ref 和 expected_draft_version。编辑后用新 request_id；相同请求重放才复用 request_id。必要时 compose_presentation/compose_block 做展示，保存后继续用最新草稿身份。
document.source 必填，自出用 {kind:"generated"}，改编用 {kind:"adapted",adapted_from_question_id:原题ID}；真实来源才用对应 source 声明。document 参数必须是原生 JSON 对象，绝不传 JSON 编码字符串。只使用下述文档字段，不加顶层 kind、prompt_md 或 difficulty。复用 schema_version:2 文档：parts[] 是小问，materials[] 是共享材料，knowledge_ids 是真实活体知识点。每 part 有稳定 part_id、prompt_md、material_ids、units。每个作答位独立 unit_id/slot_id；多空必须拆成多个 units，blank_order 列出本 part 所有 blank 的 slot_id。不要把多个答案拼进一个 blank。
每个 unit 有 response_class、response_spec、method、points、material_refs。选择用 select + set-compare，填空用 blank + exact；key.kind 与响应一致，数值 key 用 {kind:'blank',key:{kind:'numeric',value:数值}}，rule 用真实给分政策，如 {version:1,cases:[{when:{wrong:{eq:0},miss:{eq:0}},award:{points:1}}],otherwise:{points:0}}。选择 key={kind:"select",accepted_item_ids:[item_id]}；response_spec.items=[{item_id,label_md}]。证明、推导、解答用 response_class:'free',response_spec:{kind:'free'},reference_md 和 rubric.criteria:[{criterion_id,statement_md,max}]，method:{kind:'ai-rubric'}；不要把解答伪装 blank。不知道分值/材料/准入 binding 要如实缺项，不猜造。参考答案只是证据，裁决可以纠正它。
submit_question 是唯一入库闸。typed issues 当场修好再提交；withheld 且 published=true 只是等待 question_admission_run，不是 admitted。不要为等待结果重复生成或重提交。
admission_return 是每 unit 一份 return_for_repair；scoring_unit_id 标识要修的单元，repair 内给出 repair_target(question_text/scoring_structure/reference_answer/figure)、broken_part、defect、fix_hint_md、suggested_key 和 evidence_errors。根据 prior_context 找原草稿/题目，edit_question 修正后重新 submit；修复以原题证据为准，缺原图/原始条件且无法取回时说明缺什么并以 no_progress 停止；不捏造条件或换题冒充修好，不降低门硬凑。
最终输出 JSON {outcome:'done'|'no_progress',summary:事实与提交回执}。完成提交或库存满足可 done；工具/修复反复无新信息或缺材料则 no_progress。不得把 control.max_attempts 当作工具调用或外找次数上限；不要以低调用数或特殊花费上限代替判断。`,
    },
  },
  outputSchema: report,
  parseText: (text) => parseTaskOutput(text, 'QuestionPreparerTask', report),
} satisfies TaskSpec<unknown, z.infer<typeof report>>;
