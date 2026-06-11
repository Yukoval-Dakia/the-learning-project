// M3 笔记面 — 块渲染族（阅读态，YUK-317）。
// 设计基准 docs/design/loom-refresh/project/note-editor.jsx（NoteBlock 8 块型）。
// 真实块模型 = semanticBlock（kind 4 型）+ crossLinkBlock + questionRefBlock：
// - check kind（D6 内嵌自测）渲染灰色墓碑占位，不提供交互；
// - questionRefBlock（pre-flight B 用户增量）= 题面预览 + kind 徽章的纯引用块，
//   无作答判分；跳转随 quiz 域 M5 收口（占位 toast 由调用方传入）。

import { LoomIcon } from '@/ui/primitives/LoomIcon';
import { useQuery } from '@tanstack/react-query';

import {
  type BodyBlock,
  SEMANTIC_KIND_LABEL,
  type SemanticKind,
  questionsForKnowledge,
} from './notes-api';

const KIND_ICON: Record<Exclude<SemanticKind, 'check'>, string> = {
  definition: 'doc',
  mechanism: 'fx',
  example: 'list',
  pitfall: 'alert',
};

export function blockText(b: BodyBlock): string {
  return b.attrs?.source_markdown ?? '';
}

export function blockOutlineLabel(b: BodyBlock): string {
  if (b.type === 'crossLinkBlock') return b.attrs?.label ?? '交叉链';
  if (b.type === 'questionRefBlock') return b.attrs?.prompt_preview?.slice(0, 16) ?? '题目引用';
  const t = blockText(b);
  return t.slice(0, 18) || '（空块）';
}

export function QuestionRefBlock({
  block,
  onOpen,
}: {
  block: BodyBlock;
  onOpen?: (questionId: string) => void;
}) {
  return (
    <div className="nb-qref">
      <div className="nb-qref-head">
        <LoomIcon name="quiz" size={14} />
        <span className="nb-qref-tag mono">question ref</span>
        <span className="meta mono">{block.attrs?.question_id?.slice(0, 12)}</span>
      </div>
      <button
        type="button"
        className="nb-qref-body wenyan"
        onClick={() => block.attrs?.question_id && onOpen?.(block.attrs.question_id)}
      >
        {block.attrs?.prompt_preview ?? '（题面预览缺失）'}
      </button>
    </div>
  );
}

export function NoteBlockView({
  block,
  onLink,
  onOpenQuestion,
}: {
  block: BodyBlock;
  onLink?: (artifactId: string) => void;
  onOpenQuestion?: (questionId: string) => void;
}) {
  if (block.type === 'crossLinkBlock') {
    const target = block.attrs?.target;
    return (
      <button
        type="button"
        className="xlink mono"
        onClick={() => target && onLink?.(target.artifact_id)}
      >
        <LoomIcon name="link" size={11} />
        {block.attrs?.label ?? target?.artifact_id ?? '交叉链'}
      </button>
    );
  }
  if (block.type === 'questionRefBlock') {
    return <QuestionRefBlock block={block} onOpen={onOpenQuestion} />;
  }
  const kind = block.attrs?.semantic_kind;
  if (kind === 'check') {
    // D6 墓碑：内嵌自测全链路已裁，存量块只读占位。
    return (
      <div className="nb-tombstone">
        <LoomIcon name="archive" size={13} />
        <span>内嵌自测已裁撤（D6）——此块为历史存量，内容不再交互。</span>
      </div>
    );
  }
  // check 已在上方分支 return，此处 kind 已收窄为四型。
  const label = kind ? SEMANTIC_KIND_LABEL[kind] : null;
  return (
    <div className={`nb-sem nb-sem-${kind ?? 'plain'}`}>
      {label && (
        <span className="nb-sem-tag mono">
          <LoomIcon
            name={(KIND_ICON[kind as Exclude<SemanticKind, 'check'>] ?? 'doc') as never}
            size={11}
          />
          {label}
          {block.attrs?.user_verified && (
            <span className="verify-badge verified">
              <LoomIcon name="check" size={10} />
              已校验
            </span>
          )}
        </span>
      )}
      <div className="nb-sem-body" style={{ whiteSpace: 'pre-wrap' }}>
        {blockText(block)}
      </div>
    </div>
  );
}

// @ 选择器（编辑态共用）：交叉链 artifact 或题目引用。
export function QuestionPicker({
  knowledgeIds,
  onPick,
  onClose,
}: {
  knowledgeIds: string[];
  onPick: (q: { id: string; prompt_md: string }) => void;
  onClose: () => void;
}) {
  const qQ = useQuery({
    queryKey: ['question-pick', knowledgeIds],
    queryFn: () => questionsForKnowledge(knowledgeIds),
    enabled: knowledgeIds.length > 0,
  });
  return (
    <div className="slash-menu fade-key" style={{ maxHeight: 280, overflowY: 'auto' }}>
      <div className="slash-head meta">引用题目 · 按本笔记标签知识点</div>
      {qQ.isLoading && <div className="quiet-empty">取题…</div>}
      {(qQ.data?.items ?? []).map((q) => (
        <button
          type="button"
          key={q.id}
          className="slash-item"
          onClick={() => onPick({ id: q.id, prompt_md: q.prompt_md })}
        >
          <LoomIcon name="quiz" size={14} />
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {q.prompt_md.slice(0, 32)}
          </span>
          <span className="mono slash-key">{q.kind}</span>
        </button>
      ))}
      {qQ.data && qQ.data.items.length === 0 && (
        <div className="quiet-empty">本笔记标签下暂无题目。</div>
      )}
      <button type="button" className="slash-item" onClick={onClose}>
        <LoomIcon name="close" size={13} />
        <span>取消</span>
      </button>
    </div>
  );
}
