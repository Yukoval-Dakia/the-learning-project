import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { parseBlockFence } from '@/core/schema/blocks';
import type { Db, Tx } from '@/db/client';
import { event } from '@/db/schema';
import { blockDigest, blockRefForDigest } from '@/kernel/blocks/digest';
import { ApiError } from '@/kernel/http';
import { readQuestionCard } from '@/kernel/read-models/question-card';

export function chatCardSource(container: string | null) {
  const match = container?.match(/^copilot-card:([^:]+):(blk_[0-9a-f]{32})$/);
  return match
    ? { kind: 'conversation' as const, session_id: match[1], block_ref: match[2] }
    : null;
}

export async function bindChatCardIssuance(
  db: Db | Tx,
  input: {
    group_id: string;
    part_ids?: string[];
    issuance_id?: string;
    mode: string;
    container_occurrence_ref?: string | null;
    chat_card?: { session_id: string; block_ref: string };
  },
) {
  const context = input.chat_card;
  if (!context) {
    if (input.container_occurrence_ref?.startsWith('copilot-card:'))
      throw new ApiError(
        'validation_error',
        'chat card issuance requires its stored reply binding',
        400,
      );
    return null;
  }
  const replies = await db
    .select({ payload: event.payload })
    .from(event)
    .where(
      and(eq(event.session_id, context.session_id), eq(event.action, 'experimental:copilot_reply')),
    );
  let questionId: string | undefined;
  for (const reply of replies) {
    const text = typeof reply.payload.reply_md === 'string' ? reply.payload.reply_md : '';
    for (const match of text.matchAll(/```tlp-block\n([\s\S]*?)\n```/g)) {
      const block = parseBlockFence(match[1]);
      if (
        block?.kind === 'question_ref' &&
        block.display === 'inline' &&
        block.question_ids.length === 1 &&
        blockRefForDigest(blockDigest(block)) === context.block_ref
      )
        questionId = block.question_ids[0];
    }
  }
  if (!questionId)
    throw new ApiError('not_found', 'stored conversation question card not found', 404);
  const card = await readQuestionCard(db as Db, questionId);
  if (
    card.state !== 'ready' ||
    !card.question?.inline_supported ||
    card.question.group_id !== input.group_id ||
    input.mode !== 'auto_score' ||
    (input.part_ids != null &&
      JSON.stringify(input.part_ids) !== JSON.stringify(card.question.part_ids))
  )
    throw new ApiError('conflict', 'question card is not available for inline answering', 409);
  const container = `copilot-card:${context.session_id}:${context.block_ref}`;
  const digest = createHash('sha256').update(container).digest('hex');
  const issuanceId = `iss_chatcard_${digest.slice(0, 32)}`;
  if (
    (input.issuance_id != null && input.issuance_id !== issuanceId) ||
    (input.container_occurrence_ref != null && input.container_occurrence_ref !== container)
  )
    throw new ApiError('conflict', 'question card issuance coordinates do not match', 409);
  return { issuanceId, container, digest, questionId };
}
