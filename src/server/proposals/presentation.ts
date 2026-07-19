import type { AiProposalPayloadT } from '@/core/schema/proposal';
import type { Db, Tx } from '@/db/client';
import { question_block } from '@/db/schema';
import { inArray } from 'drizzle-orm';

type DbLike = Db | Tx;

const TITLE_DETAIL_CAP = 48;
const BLOCK_EXCERPT_CAP = 120;

export interface ProposalBlockPreview {
  id: string;
  label: string;
  excerpt: string;
}

export interface ProposalPresentation {
  title: string;
  block_merge: {
    primary: ProposalBlockPreview | null;
    merged: ProposalBlockPreview[];
    continuity_label: string | null;
  } | null;
}

interface ProposalPresentationInput {
  id: string;
  payload: AiProposalPayloadT;
}

function recordOf(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function textOf(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const text = value.replace(/\s+/g, ' ').trim();
  return text.length > 0 ? text : null;
}

function truncate(value: string, cap: number): string {
  if (value.length <= cap) return value;
  return `${value.slice(0, cap - 1)}…`;
}

function titled(base: string, detail: unknown): string {
  const text = textOf(detail);
  return text ? `${base}：${truncate(text, TITLE_DETAIL_CAP)}` : base;
}

/**
 * A concise learner-facing identity for every proposal kind.
 *
 * This is deliberately derived from meaningful payload fields only. Opaque ids remain in the
 * underlying payload for audit/replay, but never become the card's primary title.
 */
export function proposalDisplayTitle(payload: AiProposalPayloadT): string {
  const change = recordOf(payload.proposed_change);
  switch (payload.kind) {
    case 'knowledge_node':
      return titled('新知识点', change?.name);
    case 'knowledge_edge':
      return '调整知识关系';
    case 'knowledge_mutation':
      return titled('调整知识结构', change?.name);
    case 'learning_item':
      return titled('建立学习主线', recordOf(change?.hub)?.title ?? change?.topic);
    case 'note_update':
      return '更新学习笔记';
    case 'variant_question':
      return titled('生成变式练习', change?.prompt_md);
    case 'record_promotion':
      return '整理学习记录';
    case 'record_links':
      return '补充记录关联';
    case 'completion':
      return '确认学习项已完成';
    case 'relearn':
      return '重新巩固学习项';
    case 'goal_scope':
      return titled('确认目标范围', change?.title);
    case 'block_merge': {
      const mergedCount = Array.isArray(change?.merge_block_ids)
        ? change.merge_block_ids.length
        : 0;
      return `合并 ${mergedCount + 1} 个被切断的题块`;
    }
    case 'defer':
      return '调整学习安排';
    case 'archive':
      return '归档学习内容';
    case 'judge_retraction':
      return '复核一次 AI 判定';
    case 'image_candidate':
      return titled('图题来源', change?.source_title);
    case 'question_draft':
      return titled('审核新题', change?.prompt_md);
    case 'question_edit':
      return '修订一道题目';
    case 'conjecture':
      return titled('验证诊断推测', change?.claim_md ?? change?.claim);
    default:
      return '查看 AI 提议';
  }
}

const CONTINUITY_LABEL: Record<string, string> = {
  page_edge: '跨页延续',
  numbering: '题号连续',
  stem_answer_split: '题干与作答区被切开',
  carryover: '上下文承接',
};

function blockPreview(block: typeof question_block.$inferSelect): ProposalBlockPreview {
  const questionNo = textOf(block.structured?.question_no);
  const pageIndex = block.page_spans[0]?.page_index;
  const position = [`第 ${block.ordinal + 1} 块`];
  if (questionNo) position.push(`题号 ${questionNo}`);
  if (pageIndex !== undefined) position.push(`第 ${pageIndex + 1} 页`);
  const prompt = textOf(block.structured?.prompt_text) ?? textOf(block.extracted_prompt_md);
  return {
    id: block.id,
    label: position.join(' · '),
    excerpt: truncate(prompt ?? '题面暂缺', BLOCK_EXCERPT_CAP),
  };
}

/** Batch-enrich proposal cards without an N+1 query per block-merge card. */
export async function loadProposalPresentations(
  db: DbLike,
  proposals: readonly ProposalPresentationInput[],
): Promise<Map<string, ProposalPresentation>> {
  const presentations = new Map<string, ProposalPresentation>();
  const blockIds = new Set<string>();
  for (const proposal of proposals) {
    presentations.set(proposal.id, {
      title: proposalDisplayTitle(proposal.payload),
      block_merge: null,
    });
    if (proposal.payload.kind !== 'block_merge') continue;
    blockIds.add(proposal.payload.proposed_change.primary_block_id);
    for (const id of proposal.payload.proposed_change.merge_block_ids) blockIds.add(id);
  }

  if (blockIds.size === 0) return presentations;

  const blocks = await db
    .select()
    .from(question_block)
    .where(inArray(question_block.id, [...blockIds]));
  const blockById = new Map(blocks.map((block) => [block.id, block]));

  for (const proposal of proposals) {
    if (proposal.payload.kind !== 'block_merge') continue;
    const change = proposal.payload.proposed_change;
    const inExpectedSession = (id: string) => {
      const block = blockById.get(id);
      return block?.ingestion_session_id === change.ingestion_session_id ? block : null;
    };
    const primary = inExpectedSession(change.primary_block_id);
    const merged = change.merge_block_ids
      .map(inExpectedSession)
      .filter((block): block is typeof question_block.$inferSelect => block !== null)
      .map(blockPreview);
    presentations.set(proposal.id, {
      title: proposalDisplayTitle(proposal.payload),
      block_merge: {
        primary: primary ? blockPreview(primary) : null,
        merged,
        continuity_label: change.continuity_signal
          ? (CONTINUITY_LABEL[change.continuity_signal] ?? null)
          : null,
      },
    });
  }

  return presentations;
}
