// Wave 5 / T-D3/A — design-brief tool fixtures.
//
// Six representative DomainTool calls covering the readers + write-proposal
// surfaces visible inside the Copilot Drawer. Used by:
//   • Storybook-style previews (future)
//   • Unit tests for ToolUseCard / CopilotDrawer
//   • Drawer mock state when /today copilot-summary endpoint hasn't been
//     hooked up locally

export interface CopilotToolFixture {
  toolName: string;
  summary: string;
  costLabel: string;
  costDetail: string;
  body: string;
}

export const COPILOT_TOOL_FIXTURES: ReadonlyArray<CopilotToolFixture> = [
  {
    toolName: 'query_mistakes',
    summary: 'mistakes · 8 行 · 3 道过期',
    costLabel: '0.4¢',
    costDetail: 'local · 4ms · 8 rows · cost 4¢/1000',
    body: '近 14 天错题集中在《将进酒》典故 / 通假字两类，建议优先恢复 #wj_2 #wj_5 #wj_7。',
  },
  {
    toolName: 'get_review_due',
    summary: 'review · 12 due 今日 · 4 due 明日',
    costLabel: '0.2¢',
    costDetail: 'local · 3ms · scope=today',
    body: '今日推荐先复习概念错因，再做 1 题变式巩固。已逾期 4 道集中在通假字，可与 Coach 的 plan_adjustment 联动。',
  },
  {
    toolName: 'get_learning_item_context',
    summary: 'LI #wj_5 状态 in_progress · 3 attempts',
    costLabel: '0.3¢',
    costDetail: 'local · 5ms · last_attempt 4h ago',
    body: '正在做《将进酒》主题学习项，已尝试 3 次；上次卡在通假字识别。',
  },
  {
    toolName: 'query_memory_brief',
    summary: 'brief · 偏好"先讲后练" · 倾向 hard',
    costLabel: '0.5¢',
    costDetail: 'memory · 7ms · 12 prefs',
    body: '近一周偏好显示：先讲后练；对 hard 级别变式接受度高；不喜欢长 prompt。',
  },
  {
    toolName: 'propose_knowledge_edge',
    summary: 'edge 通假字→典故识别 已提交 #p_42',
    costLabel: '1.1¢',
    costDetail: 'propose · 18ms · cooldown_key=edge:通假字-典故',
    body: '已写入提案 #p_42。等用户 Today 列表接受后才会真正落库。',
  },
  {
    toolName: 'propose_variant',
    summary: '变式提案 3 道 提交 #p_43 #p_44 #p_45',
    costLabel: '2.4¢',
    costDetail: 'propose · 32ms · source_question=wj_5',
    body: '基于 wj_5 出 3 道变式提案，覆盖 通假 / 典故 / 句法 三角度。',
  },
];
