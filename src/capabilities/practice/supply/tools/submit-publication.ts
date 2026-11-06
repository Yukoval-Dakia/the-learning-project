// Publication display for submit_question outputs. Publication truth is owned by
// @/kernel/records/publication-receipt; this module only renders the owner's receipts
// for the model. No decision reads these fields.
import type { PublishQuestionGroupResult } from '@/kernel/records/assessment-publication';
import {
  type PublicationIdentity,
  type PublicationReceiptT,
  publicationReceiptFromSubmit,
} from '@/kernel/records/publication-receipt';

/** Display fields derived from the owner receipt. */
export function publicationDisplay(receipt: PublicationReceiptT | null) {
  return receipt == null
    ? {}
    : {
        revision_id: receipt.revision_id,
        ...(receipt.publication_event_id != null
          ? { publication_event_id: receipt.publication_event_id }
          : {}),
      };
}

/** Receipt for a flat candidate seam result; throws when a publishing result cannot
 *  name its group/revision/event (the submit transaction must roll back). */
export function flatCandidatePublication(
  publication: PublishQuestionGroupResult,
  identity: PublicationIdentity,
): PublicationReceiptT | null {
  return publicationReceiptFromSubmit(
    {
      publish_status: publication.status,
      group_id: publication.group_id,
      revision_id:
        'revision_id' in publication
          ? publication.revision_id
          : 'current_revision_id' in publication
            ? publication.current_revision_id
            : null,
      publication_event_id: 'event_id' in publication ? publication.event_id : null,
    },
    identity,
  );
}
