import { z } from 'zod';
import {
  AdmissionPurposeImpact,
  PurposeChangeReceipt,
  PurposeRepairRecord,
} from '@/kernel/read-models/purpose-change';

export const PurposeImpactQuery = z.object({ request_id: z.string().uuid().optional() }).strict();
export const PurposeChangeResponse = z
  .object({ receipt: PurposeChangeReceipt, replayed: z.boolean() })
  .strict();
export const PurposeImpactResponse = z
  .object({
    current: z.object({
      session_id: z.string(),
      source_document_id: z.string(),
      version: z.number().int(),
      policy: z.enum(['allow', 'answer_only', 'crisis']),
      epoch: z.string(),
    }),
    receipt: PurposeChangeReceipt.nullable(),
    stop: z.array(
      z.object({
        session_id: z.string(),
        run_ref: z.string().nullable(),
        operation_id: z.string().nullable(),
        state: z.enum(['confirmed', 'pending', 'unknown']),
      }),
    ),
    repairs: z.array(PurposeRepairRecord),
    cleanup: z.enum(['pending_or_partial', 'not_requested']),
    sinks: z.object({
      mem0: z.enum(['pending_or_partial', 'not_requested']),
      briefs: z.array(
        z.object({
          scope_key: z.string(),
          state: z.enum(['complete', 'pending', 'failed', 'unknown']),
        }),
      ),
    }),
    external_effect: z.literal('unknown_or_irreversible'),
    unattributed: z.literal('unknown'),
    backup: z.literal('unknown'),
    trace: z.literal('unknown'),
    sqlite_history: z.literal('unknown'),
    admission: AdmissionPurposeImpact,
  })
  .strict();
