import type { DocxOmittedExternalRef } from '@/core/schema/docx-omission';

// YUK-1476 — zero-dependency leaf holding the shared external-ref omission
// contract. Both DOCX lines consume it (text: docx-ingestion, visual: ingestion)
// so the receipt cannot drift. The core type is erased at runtime; no new store.

/** Audit facts for external resources omitted from the DOCX converter-input copy. */
export interface DocxExternalRefOmissionFacts {
  /** SHA-256 (hex) of the ORIGINAL uploaded docx bytes. */
  inputSha256: string;
  /** SHA-256 (hex) of the sanitized converter-input copy. */
  converterInputSha256: string;
  /** What was omitted (part + rId + public type category — never the external Target URL). */
  omissions: DocxOmittedExternalRef[];
}

// Owner-fixed learner wording (2026-10-11): states the omission plainly, leaks
// no remote URL / PII, and rides the EXISTING learning_session.warnings field
// (already part of the session-detail DTO) — no new copy surface.
export const EXTERNAL_REF_OMISSION_NOTICE = '已忽略外部链接';
