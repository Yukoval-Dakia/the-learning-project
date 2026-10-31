// Practice owns intervention package authoring. The preparation job calls this
// port so that job does not import the practice capability. The worker binds
// the practice author before jobs mount. The call object is forwarded intact:
// this module does not name the server task runner.

import type { InterventionPreparationAttemptT } from '@/core/schema/intervention';
import type { Db } from '@/db/client';

export interface InterventionAuthorCall {
  attempt: 1 | 2;
  preparationJobId: string;
}

export type InterventionPackageAuthor = (
  db: Db,
  interventionId: string,
  call: InterventionAuthorCall,
) => Promise<InterventionPreparationAttemptT>;

let boundAuthor: InterventionPackageAuthor | undefined;

export function bindInterventionPackageAuthor(author: InterventionPackageAuthor): void {
  boundAuthor = author;
}

export async function authorInterventionPackage(
  db: Db,
  interventionId: string,
  call: InterventionAuthorCall,
): Promise<InterventionPreparationAttemptT> {
  const author = boundAuthor;
  if (!author) {
    throw new Error(
      'intervention package author is not installed; call installInterventionPackageAuthor before prepare_intervention',
    );
  }
  return author(db, interventionId, call);
}
