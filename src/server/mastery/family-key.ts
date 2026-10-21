// Single source of family_key parsing for the write path and both read paths.
//
// family_key = `${subject}:${primaryKnowledgeId}:${kind}:${source}`. `subject` is derived,
// not stored: primaryKnowledgeId's effective domain → resolveKnownSubjectId. Orphans and
// unknown domains become 'unknown' so they never fall into a default profile.
//
// Both paths must resolve archived ancestors the same way (archived-inclusive). An
// archived-cutoff walk would write `<subject>:...` but read `unknown:...`, silently
// disabling the family delta for those KCs.
//
// getEffectiveDomain throws for orphan ids; this module catches that into 'unknown' so
// subject derivation can never abort a θ̂ update.

import { batchResolveEffectiveDomains, getEffectiveDomain } from '@/capabilities/knowledge/public';
import type { Db, Tx } from '@/db/client';
import { resolveKnownSubjectId } from '@/subjects/profile';
import { buildFamilyKey } from './family-key-format';

type DbLike = Db | Tx;

export interface FamilyKeyInput {
  /** 题目的主 knowledge_id（q.knowledge_ids[0]）。空 → 无法成键 → null。 */
  primaryKnowledgeId: string | null | undefined;
  /** question.kind。 */
  kind: string | null | undefined;
  /** question.source。 */
  source: string | null | undefined;
}

/**
 * family_key for one question, or null when primaryKnowledgeId/kind/source is missing.
 * Orphan or unknown domain becomes 'unknown' (never a default subject, never a crash).
 */
export async function resolveFamilyKeyForQuestion(
  db: DbLike,
  input: FamilyKeyInput,
): Promise<string | null> {
  const primaryKnowledgeId = input.primaryKnowledgeId?.trim();
  if (!primaryKnowledgeId || !input.kind || !input.source) return null;

  let subject = 'unknown';
  try {
    const domain = await getEffectiveDomain(db, primaryKnowledgeId);
    subject = resolveKnownSubjectId(domain) ?? 'unknown';
  } catch {
    subject = 'unknown';
  }

  return buildFamilyKey(subject, primaryKnowledgeId, input.kind, input.source);
}

/**
 * Batch variant. Derives each subject once from a single full-tree read instead of one
 * DB climb per candidate; missing kind/source/primaryKnowledgeId still yields null.
 */
export async function batchResolveFamilyKeys(
  db: DbLike,
  items: Array<{ questionId: string } & FamilyKeyInput>,
): Promise<Map<string, string | null>> {
  const out = new Map<string, string | null>();
  if (items.length === 0) return out;

  // Reuse getEffectiveDomain's canonical batch twin so archived-inclusive traversal and the
  // MAX_DEPTH boundary stay identical to the single-question path (YUK-722).
  const primaryKnowledgeIds = items.flatMap((item) => {
    const id = item.primaryKnowledgeId?.trim();
    return id && item.kind && item.source ? [id] : [];
  });
  const domainByKid = await batchResolveEffectiveDomains(db, primaryKnowledgeIds);

  // Questions of the same KC share one subject lookup.
  const subjectByKid = new Map<string, string>();

  for (const item of items) {
    const primaryKnowledgeId = item.primaryKnowledgeId?.trim();
    if (!primaryKnowledgeId || !item.kind || !item.source) {
      out.set(item.questionId, null);
      continue;
    }
    let subject = subjectByKid.get(primaryKnowledgeId);
    if (subject === undefined) {
      const domain = domainByKid.get(primaryKnowledgeId) ?? null;
      subject = resolveKnownSubjectId(domain) ?? 'unknown';
      subjectByKid.set(primaryKnowledgeId, subject);
    }
    out.set(item.questionId, buildFamilyKey(subject, primaryKnowledgeId, item.kind, item.source));
  }

  return out;
}
