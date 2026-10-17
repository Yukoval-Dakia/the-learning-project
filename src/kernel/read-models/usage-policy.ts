// YUK-1408 (Stage 1 B6 S1) — ingestion usage policy resolution.
//
// The learner's consented usage for an uploaded document is stored on
// `source_document.provenance.usage_policy` (open catchall — mirrors the
// learner_selected_subject_id precedent, no new column). These resolvers let
// every ingestion-derived event inherit the document's `derivation_policy` at
// write time so the EXISTING derivation filter
// (src/kernel/events/derivation-policy.ts + writeEvent's answer_only handling)
// drops them from memory/brief channels when consent is withdrawn — no second
// mechanism.
//
// Absence preserves legacy behavior: a document without usage_policy resolves
// to 'allow'.

import { eq } from 'drizzle-orm';
import { type DerivationPolicyT, readDerivationPolicy } from '@/core/schema/derivation-policy';
import type { Db, Tx } from '@/db/client';
import { learning_session, source_document } from '@/db/schema';

/** `source_document.provenance` key holding the learner's consented usage. */
export const USAGE_POLICY_PROVENANCE_KEY = 'usage_policy';

/** Read the consented usage off a source_document provenance blob. */
export function readDocumentDerivationPolicy(provenance: unknown): DerivationPolicyT {
  const record =
    typeof provenance === 'object' && provenance !== null
      ? (provenance as Record<string, unknown>)[USAGE_POLICY_PROVENANCE_KEY]
      : undefined;
  return readDerivationPolicy(record);
}

/** Resolve the usage policy for an ingestion session's source document. */
export async function resolveSessionDerivationPolicy(
  db: Db | Tx,
  sessionId: string,
): Promise<DerivationPolicyT> {
  const [row] = await db
    .select({ provenance: source_document.provenance })
    .from(learning_session)
    .innerJoin(source_document, eq(source_document.id, learning_session.source_document_id))
    .where(eq(learning_session.id, sessionId))
    .limit(1);
  return row ? readDocumentDerivationPolicy(row.provenance) : 'allow';
}

/** Resolve the usage policy directly off a source_document id. */
export async function resolveDocumentDerivationPolicy(
  db: Db | Tx,
  sourceDocumentId: string,
): Promise<DerivationPolicyT> {
  const [row] = await db
    .select({ provenance: source_document.provenance })
    .from(source_document)
    .where(eq(source_document.id, sourceDocumentId))
    .limit(1);
  return row ? readDocumentDerivationPolicy(row.provenance) : 'allow';
}

export interface DocumentUsage {
  policy: DerivationPolicyT;
  /**
   * The ingestion session bound to the document (learning_session is 1:1 with
   * source_document — upload creates both together). Events that carry this
   * session_id inherit the LIVE document policy through the shared derivation
   * filter, so consent withdrawal reaches them without payload mutation.
   */
  sessionId: string | null;
}

/** Resolve both the policy and the bound ingestion session for a document. */
export async function resolveDocumentUsage(
  db: Db | Tx,
  sourceDocumentId: string,
): Promise<DocumentUsage> {
  const [row] = await db
    .select({
      provenance: source_document.provenance,
      sessionId: learning_session.id,
    })
    .from(source_document)
    .leftJoin(learning_session, eq(learning_session.source_document_id, source_document.id))
    .where(eq(source_document.id, sourceDocumentId))
    .limit(1);
  return {
    policy: row ? readDocumentDerivationPolicy(row.provenance) : 'allow',
    sessionId: row?.sessionId ?? null,
  };
}
