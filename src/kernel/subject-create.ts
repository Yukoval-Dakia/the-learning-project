import type { Db } from '@/db/client';
import {
  HostOperationNotInstalledError,
  installHostOperation,
  installedHostOperation,
} from '@/kernel/host-operation';

// Subject creation stays with the registry owner (observability). Question authoring
// needs it for a learner-named subject but may not import that capability, so the host
// installs the real writer here. The result shape mirrors the owner's thin-create
// contract: the installed implementation is assignment-compatible without kernel
// importing the capability.
export interface CreatedSubject {
  id: string;
  displayName: string;
  isGeneralFallback: boolean | null;
  revision: number;
  seedRootId: string;
}

export type SubjectCreateResult =
  | { kind: 'created'; payload: CreatedSubject }
  | { kind: 'replayed'; payload: CreatedSubject }
  | { kind: 'invalid'; message: string }
  | { kind: 'name_conflict'; message: string };

export interface SubjectCreateSource {
  /** The learner ask event that justified creating this subject. */
  askEventId: string;
  /** The AI task run that authored the question. */
  taskRunId: string;
}

type SubjectCreateOperation = (
  db: Db,
  displayName: string,
  source?: SubjectCreateSource,
) => Promise<SubjectCreateResult>;

const CREATE_SLOT = 'kernel/subject-create:create';

export function installSubjectCreateOperation(create: SubjectCreateOperation): void {
  installHostOperation(CREATE_SLOT, create);
}

export function createSubjectThroughPort(
  ...args: Parameters<SubjectCreateOperation>
): ReturnType<SubjectCreateOperation> {
  const create = installedHostOperation<SubjectCreateOperation>(CREATE_SLOT);
  if (!create) {
    throw new HostOperationNotInstalledError(
      'subject creation is not installed; call installObservabilityHostOperations at startup',
    );
  }
  return create(...args);
}
