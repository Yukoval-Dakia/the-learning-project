// A saved tool result (a hero the companion nominated): read-only, from the snapshot saved with
// the reply, never re-run. Values render as text only — a saved result is data, never HTML or a link.

import { useId, useState } from 'react';
import { Expand } from '@/ui-next/public';
import type { CopilotToolResultSnapshot, ToolResultJson } from '../../primary-view-contract';
import { TOOL_LABELS } from './tool-labels';

const FIELD_LABELS: Readonly<Record<string, string>> = {
  nodes: '知识点',
  edges: '关联',
  paths: '路径',
  records: '记录',
  questions: '题目',
  question: '题目详情',
  subject_id: '科目',
  kind: '类型',
  choices_md: '选项',
  rubric_json: '评分依据',
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

const UNAVAILABLE: Readonly<Record<string, string>> = {
  internal_only: '这项内部操作的结果不公开展示。',
  content_rejected: '这份内容没通过校验，暂不展示。',
  size_limit: '结果太大，没有保存下来；不会自动重新查询。',
  unsupported_result: '这类结果暂时没法用卡片展示。',
};

function Nested({ value, depth, label }: { value: ToolResultJson; depth: number; label: string }) {
  const [open, setOpen] = useState(depth < 2);
  const id = useId();
  return (
    <>
      <button
        type="button"
        className="un-cp-result-more un-hit"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => setOpen((v) => !v)}
      >
        {label}
      </button>
      <Expand open={open} id={id}>
        <ResultValue value={value} depth={depth + 1} />
      </Expand>
    </>
  );
}

function ResultValue({ value, depth = 0 }: { value: ToolResultJson; depth?: number }) {
  if (value === null) return <span>未知</span>;
  if (typeof value === 'boolean') return <span>{value ? '是' : '否'}</span>;
  if (typeof value !== 'object')
    return <span className="un-cp-result-text">{value === '' ? '空' : String(value)}</span>;
  if (Array.isArray(value)) {
    if (!value.length) return <span>没有记录</span>;
    return (
      <ol className="un-cp-result-list">
        {value.map((entry, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: a saved snapshot keeps its captured order.
          <li key={index}>
            <ResultValue value={entry} depth={depth + 1} />
          </li>
        ))}
      </ol>
    );
  }
  const entries = Object.entries(value);
  if (!entries.length) return <span>没有可展示的内容</span>;
  return (
    <dl className="un-cp-result-fields">
      {entries.map(([key, entry]) => (
        <div key={key} className="un-cp-result-field">
          <dt>{FIELD_LABELS[key] ?? key}</dt>
          <dd>
            {entry !== null && typeof entry === 'object' ? (
              <Nested
                value={entry}
                depth={depth}
                label={Array.isArray(entry) ? `查看 ${entry.length} 项` : '查看详情'}
              />
            ) : (
              <ResultValue value={entry} depth={depth + 1} />
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function ToolResultSnapshot({
  toolName,
  snapshot,
}: {
  toolName: string;
  snapshot?: CopilotToolResultSnapshot;
}) {
  return (
    <section className="un-cp-card un-cp-result" aria-label={TOOL_LABELS[toolName] ?? '查询结果'}>
      <p className="un-cp-card-title">{TOOL_LABELS[toolName] ?? '查询结果'}</p>
      {snapshot?.state === 'available' ? (
        <>
          <ResultValue value={snapshot.value} />
          {snapshot.completeness === 'projected' ? (
            <p className="un-cp-card-note">
              只展示可以公开的部分。
              {snapshot.omissions.some((item) => item.reason === 'display_limit')
                ? '结果较多，有些条目没有放进来。'
                : ''}
            </p>
          ) : null}
        </>
      ) : (
        <p className="un-cp-card-note">
          {snapshot ? UNAVAILABLE[snapshot.reason] : '这条历史消息没有保存结果；不会自动重新查询。'}
        </p>
      )}
    </section>
  );
}
