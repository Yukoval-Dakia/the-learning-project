import { ToolUseCard } from '@/ui/primitives/ToolUseCard';
import type { CopilotToolResultSnapshot, ToolResultJson } from '../primary-view-contract';

const TOOL_LABELS: Record<string, string> = {
  query_memory_brief: '学习概况',
  generate_goal_outline: '目标大纲',
  generate_question_candidate: '题目草稿',
  get_subject_graph_overview: '知识概览',
  query_knowledge: '知识点',
  query_events: '学习动态',
  query_records: '学习记录',
  get_record_context: '记录详情',
  get_question_context: '题目详情',
  query_mistakes: '错题分析',
  get_attempt_context: '作答详情',
  get_review_due: '待复习内容',
  get_learning_item_context: '学习项详情',
  expand_knowledge_subgraph: '关联知识',
  find_knowledge_paths: '知识路径',
  query_questions: '题目',
  search_memory_facts: '记忆检索',
  propose_knowledge_edge: '知识关联提议',
  propose_knowledge_mutation: '知识调整提议',
  propose_learning_item_completion: '完成学习提议',
  propose_learning_item_relearn: '重新学习提议',
  propose_learning_item_defer: '推迟学习提议',
  propose_learning_item_archive: '归档学习提议',
  author_question: '题目生成结果',
  propose_question_edit: '题目修改提议',
  attribute_mistake: '错因分析结果',
  propose_variant: '变式提议',
  write_quiz: '练习生成结果',
  author_artifact: '资料生成结果',
  update_artifact: '资料更新结果',
};
const FIELD_LABELS: Record<string, string> = {
  nodes: '知识点',
  edges: '关联',
  paths: '路径',
  records: '记录',
  questions: '题目',
  events: '动态',
  items: '条目',
  results: '结果',
  facts: '记忆',
  count: '数量',
  name: '名称',
  title: '标题',
  summary: '摘要',
  text: '内容',
  description: '说明',
  status: '状态',
  score: '得分',
  mastery: '掌握程度',
  confidence: '可信度',
  coverage: '证据覆盖',
  claim_boundaries: '结论边界',
  context_budget: '读取范围',
  has_more: '还有更多',
  total: '总数',
  evidence: '证据',
  observed: '已观测',
  remaining: '剩余',
  from_id: '起点',
  to_id: '终点',
  relation: '关系',
  stats: '学习状态',
  mastery_estimate: '掌握程度',
  last_touched_at: '最近学习时间',
  returned_node_count: '本次返回数量',
  seed_matches_complete: '匹配范围完整',
  returned_count: '本次返回数量',
  limit: '读取上限',
  complete: '范围完整',
  prompt_md: '题目',
  prompt_preview: '题目预览',
  prompt_excerpt: '题目摘要',
  content_md: '内容',
  reference_md: '参考答案',
  analysis_md: '分析',
  recent_failures: '近期错题',
  question_id: '题目编号',
  knowledge_ids: '关联知识点',
};

/** Text nodes only: a saved result is data, never executable HTML or a URL. */
function ResultValue({ value, depth = 0 }: { value: ToolResultJson; depth?: number }) {
  if (value === null) return <span>未知（null）</span>;
  if (typeof value === 'boolean') return <span>{value ? '是（true）' : '否（false）'}</span>;
  if (typeof value !== 'object')
    return (
      <span className="whitespace-pre-wrap break-words">
        {value === '' ? '空文本' : String(value)}
      </span>
    );
  if (Array.isArray(value)) {
    if (!value.length) return <span>无记录（0 项）</span>;
    return (
      <ol className="space-y-2 list-decimal pl-5">
        {value.map((entry, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: Snapshot lists are immutable and retain their captured order.
          <li key={index}>
            <ResultValue value={entry} depth={depth + 1} />
          </li>
        ))}
      </ol>
    );
  }
  const entries = Object.entries(value);
  if (!entries.length) return <span>没有公开字段</span>;
  return (
    <dl className="space-y-2">
      {entries.map(([key, entry]) => (
        <div
          key={key}
          className={
            entry !== null && typeof entry === 'object'
              ? ''
              : 'grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-2'
          }
        >
          <dt className="text-[var(--ink-3)]">{FIELD_LABELS[key] ?? key}</dt>
          <dd className="ml-2">
            {entry !== null && typeof entry === 'object' ? (
              <details open={depth < 3}>
                <summary>查看{Array.isArray(entry) ? ` ${entry.length} 项` : '详情'}</summary>
                <ResultValue value={entry} depth={depth + 1} />
              </details>
            ) : (
              <ResultValue value={entry} depth={depth + 1} />
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function ToolResultView({
  toolName,
  snapshot,
}: {
  toolName: string;
  snapshot?: CopilotToolResultSnapshot;
}) {
  const available = snapshot?.state === 'available';
  const unavailable = !snapshot
    ? '这条历史消息没有保存结果快照；不会自动重新查询。'
    : snapshot.state === 'unavailable'
      ? {
          internal_only: '这项内部操作的结果不公开展示。',
          content_rejected: '这份内容未通过校验，暂不展示。',
          size_limit: '结果超过展示范围，快照未保存；不会自动重新查询。',
          unsupported_result: '这类结果暂不支持卡片展示。',
        }[snapshot.reason]
      : '';
  return (
    <ToolUseCard
      toolName={TOOL_LABELS[toolName] ?? '操作结果'}
      icon="eye"
      actor={null}
      result={
        available ? (
          <div className="space-y-3">
            <ResultValue value={snapshot.value} />
            {snapshot.completeness === 'projected' && (
              <p className="text-[var(--ink-3)]">
                仅展示公开字段。
                {snapshot.omissions.some((item) => item.reason === 'display_limit')
                  ? '结果较多，部分条目未包含在这份快照中。'
                  : ''}
              </p>
            )}
          </div>
        ) : (
          <p>{unavailable}</p>
        )
      }
    />
  );
}
