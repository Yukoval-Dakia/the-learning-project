// M3 笔记面 — 块渲染族（阅读态，YUK-317）。
// 设计基准 docs/design/loom-refresh/project/note-editor.jsx（NoteBlock 8 块型）。
// 真实块模型 = semanticBlock（kind 5 型）+ crossLinkBlock + questionRefBlock：
// - check kind 保留自解释正文，不提供内嵌作答/判分；
// - questionRefBlock（pre-flight B 用户增量）= 题面预览 + 类型徽章的纯引用块，
//   无作答判分；点击进入现有题目详情页。
// M3E presentation (YUK-1473, docs/design/2026-11-03-notes-m3e.md): markup and classes only.

import { useQuery } from '@tanstack/react-query';
import {
  Check,
  ChevronRight,
  CircleQuestionMark,
  FileText,
  Link,
  List,
  type LucideIcon,
  Sigma,
  TriangleAlert,
  X,
} from 'lucide-react';
import { MathMarkdown } from '@/ui/lib/math-markdown';
import { Chip } from '@/ui-next/public';

import {
  type BodyBlock,
  SEMANTIC_KIND_LABEL,
  type SemanticKind,
  questionsForKnowledge,
} from './notes-api';

const KIND_ICON: Record<SemanticKind, LucideIcon> = {
  definition: FileText,
  mechanism: Sigma,
  example: List,
  pitfall: TriangleAlert,
  check: FileText,
};

function VerifiedChip() {
  return (
    <Chip tone="positive">
      <Check size={12} aria-hidden="true" />
      已校验
    </Chip>
  );
}

export function questionDetailHref(questionId: string): string {
  return `/questions/${encodeURIComponent(questionId)}`;
}

export function blockText(b: BodyBlock): string {
  return b.attrs?.source_markdown ?? '';
}

export function blockOutlineLabel(b: BodyBlock): string {
  if (b.type === 'crossLinkBlock') return b.attrs?.title ?? '交叉链';
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
  const questionId = block.attrs?.question_id;
  return (
    <div className="nt-qref">
      <div className="nt-qref-head">
        <CircleQuestionMark size={14} aria-hidden="true" />
        <span className="nt-qref-tag">题目引用</span>
      </div>
      {/* de-wenyan: BodyBlock carries no subject domain → neutral default font
          (subject-driven question-ref preview is a follow-up). */}
      <button
        type="button"
        className="nt-qref-body"
        disabled={!questionId}
        onClick={() => questionId && onOpen?.(questionId)}
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
  variant = 'edit',
}: {
  block: BodyBlock;
  onLink?: (artifactId: string) => void;
  onOpenQuestion?: (questionId: string) => void;
  // S12 (YUK-335)：read 态把 crossLink 渲成整宽 BlockLinkCard（设计源
  // screen-note-reader.jsx:17 BlockLinkCard）；edit 态保持 inline 小 pill 不动。
  // 默认 'edit' 使 NoteEditor 既有调用（无 variant）零行为改动。
  variant?: 'read' | 'edit';
}) {
  if (block.type === 'crossLinkBlock') {
    // ADR-0022 canonical flat attrs：{ id, artifact_id, block_id?, title? }
    //（服务端 block-refs 索引器同源）——勿读嵌套 target。
    const targetId = block.attrs?.artifact_id;
    if (variant === 'read') {
      // 整宽链接卡。真实 crossLinkBlock 是 artifact 引用，无 mastery，
      // kind 固定「交叉链」（flat attrs 无类型字段，不 fabricate）；目标名取 title，
      // 缺则回退 artifact_id（block-refs 索引器同源字段）。
      return (
        <button
          type="button"
          className="nt-linkcard"
          onClick={() => targetId && onLink?.(targetId)}
        >
          <span className="nt-linkcard-icon" aria-hidden="true">
            <Link size={16} />
          </span>
          <span className="nt-linkcard-body">
            <span className="nt-linkcard-title">{block.attrs?.title ?? targetId ?? '交叉链'}</span>
            <span className="nt-linkcard-sub">交叉链 · {targetId ?? '—'}</span>
          </span>
          <ChevronRight className="nt-linkcard-arrow" size={16} aria-hidden="true" />
        </button>
      );
    }
    return (
      <button type="button" className="nt-xlink" onClick={() => targetId && onLink?.(targetId)}>
        <Link size={12} aria-hidden="true" />
        {block.attrs?.title ?? targetId ?? '交叉链'}
      </button>
    );
  }
  if (block.type === 'questionRefBlock') {
    return <QuestionRefBlock block={block} onOpen={onOpenQuestion} />;
  }
  const kind = block.attrs?.semantic_kind;
  const label = kind ? SEMANTIC_KIND_LABEL[kind] : null;
  // YUK-339：read 态的 kind 标签由小节标题（NoteDocBody）承载，块内不再重复渲染
  // chip——只保留 user_verified 徽章；edit 态（NoteEditor）保持原 chip 不变。
  const showTagChip = variant === 'edit' && label;
  const showVerifiedAlone = variant === 'read' && block.attrs?.user_verified;
  const KindIcon = KIND_ICON[kind as SemanticKind] ?? FileText;
  return (
    <div className={`nt-sem nt-sem-${kind ?? 'plain'}`}>
      {showTagChip && (
        <span className="nt-sem-tag">
          <KindIcon size={12} aria-hidden="true" />
          {label}
          {block.attrs?.user_verified && <VerifiedChip />}
        </span>
      )}
      {showVerifiedAlone && (
        <span className="nt-sem-tag">
          <VerifiedChip />
        </span>
      )}
      {/* YUK-1548 — read: the block's markdown rendered through the shared reading layer
          (formulas included; a note carries no subject notation, so the renderer's fallback
          decides). Edit keeps the source text. */}
      {variant === 'read' ? (
        <MathMarkdown className="nt-sem-body un-read">{blockText(block)}</MathMarkdown>
      ) : (
        <div className="nt-sem-body">{blockText(block)}</div>
      )}
    </div>
  );
}

// @ 选择器（编辑态共用）：交叉链 artifact 或题目引用。
export function QuestionPicker({
  knowledgeIds,
  onPick,
  onClose,
  readQuestions = questionsForKnowledge,
}: {
  knowledgeIds: string[];
  onPick: (q: { id: string; prompt_md: string }) => void;
  onClose: () => void;
  readQuestions?: typeof questionsForKnowledge;
}) {
  const qQ = useQuery({
    queryKey: ['question-pick', knowledgeIds],
    queryFn: () => readQuestions(knowledgeIds),
    enabled: knowledgeIds.length > 0,
  });
  return (
    <div className="nt-menu un-glass">
      <div className="nt-menu-head">引用题目 · 按本笔记标签知识点</div>
      {qQ.isLoading && <div className="nt-menu-note">取题…</div>}
      {(qQ.data?.items ?? []).map((q) => (
        <button
          type="button"
          key={q.id}
          className="nt-menu-item"
          onClick={() => onPick({ id: q.id, prompt_md: q.prompt_md })}
        >
          <CircleQuestionMark size={15} aria-hidden="true" />
          <span className="nt-menu-label">{q.prompt_md.slice(0, 32)}</span>
          <span className="nt-menu-key">{q.kind}</span>
        </button>
      ))}
      {qQ.data && qQ.data.items.length === 0 && (
        <div className="nt-menu-note">本笔记标签下暂无题目。</div>
      )}
      <button type="button" className="nt-menu-item" onClick={onClose}>
        <X size={15} aria-hidden="true" />
        <span>取消</span>
      </button>
    </div>
  );
}
