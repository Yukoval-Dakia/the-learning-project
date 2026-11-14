import { publicAssistancePayload } from './assistance-publication';

/** Generic readers expose operations; protected evidence is released by its bound owner. */
export function publicEventPayload(action: string, payload: Record<string, unknown>) {
  if (action === 'experimental:completion_evidence_read') return {};
  if (action === 'experimental:proposal') {
    const proposal = payload.ai_proposal ?? payload;
    if (
      proposal !== null &&
      typeof proposal === 'object' &&
      'kind' in proposal &&
      proposal.kind === 'completion'
    ) {
      // Rebuild the whole payload: reasons, labels and summaries can contain the
      // same private facts as the receipt, including on legacy flat proposals.
      return { kind: 'completion' };
    }
  }
  return publicAssistancePayload(action, payload);
}
