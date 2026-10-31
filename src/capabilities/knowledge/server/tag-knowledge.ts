// Knowledge owns the DashScope embed wire used by match-or-propose tagging.
// The decision itself lives in the kernel tagger; this module only binds the wire
// so kernel records never import server/ai.

import {
  type KnowledgeTagProviderAttempt,
  bindKnowledgeTagEmbedder,
} from '@/kernel/records/knowledge-tag';
import { EMBED_MODEL, type EmbedProviderAttemptOptions, embedText } from '@/server/ai/embed';

function embedForTag(
  text: string,
  providerAttempt: KnowledgeTagProviderAttempt | undefined,
): Promise<number[]> {
  return embedText(text, providerAttempt as EmbedProviderAttemptOptions | undefined);
}

bindKnowledgeTagEmbedder({
  model: EMBED_MODEL,
  embed: embedForTag,
});
