// Ingestion usage policy. Consent lives in source_document.provenance.usage_policy
// (no new column). Events inherit the document's derivation policy at write time, so
// the existing derivation filter withholds them when consent is withdrawn.
//
// A document without a policy resolves to 'allow' (legacy behavior).

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
   * Bound ingestion session. Events carrying it inherit the live document policy,
   * so consent withdrawal reaches them without payload mutation.
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
