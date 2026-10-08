import { createServerFn } from '@tanstack/react-start';
import { getRequest } from '@tanstack/react-start/server';
import type { AdminControlClient } from '@/capabilities/observability/ui-public';
import { runAuthenticatedStartAdminControl } from './admin-control-read';

// Identity validators leave parsing to the canonical adapter after auth and epoch.
export const getStartAdminConfig = createServerFn({ method: 'GET' }).handler(({ context }) =>
  runAuthenticatedStartAdminControl(context, getRequest(), async (controls) =>
    JSON.stringify(await controls.getConfig()),
  ),
);
export const patchStartAdminConfig = createServerFn({ method: 'POST' })
  .inputValidator((input: Parameters<AdminControlClient['patchConfig']>[0]) => input)
  .handler(({ context, data }) =>
    runAuthenticatedStartAdminControl(context, getRequest(), (controls) =>
      controls.patchConfig(data),
    ),
  );
export const resetStartAdminConfig = createServerFn({ method: 'POST' })
  .inputValidator((input: Parameters<AdminControlClient['resetConfig']>[0]) => input)
  .handler(({ context, data }) =>
    runAuthenticatedStartAdminControl(context, getRequest(), (controls) =>
      controls.resetConfig(data),
    ),
  );
export const getStartAdminSubjects = createServerFn({ method: 'GET' }).handler(({ context }) =>
  runAuthenticatedStartAdminControl(context, getRequest(), (controls) => controls.getSubjects()),
);
export const getStartAdminSubjectTraits = createServerFn({ method: 'GET' })
  .inputValidator((input: Parameters<AdminControlClient['getSubjectTraits']>[0]) => input)
  .handler(({ context, data }) =>
    runAuthenticatedStartAdminControl(context, getRequest(), async (controls) =>
      JSON.stringify(await controls.getSubjectTraits(data)),
    ),
  );
export const getStartAdminTraits = createServerFn({ method: 'GET' })
  .inputValidator((input: Parameters<AdminControlClient['getTraits']>[0]) => input)
  .handler(({ context, data }) =>
    runAuthenticatedStartAdminControl(context, getRequest(), (controls) =>
      controls.getTraits(data),
    ),
  );
export const getStartAdminTraitJournal = createServerFn({ method: 'GET' })
  .inputValidator((input: Parameters<AdminControlClient['getTraitJournal']>[0]) => input)
  .handler(({ context, data }) =>
    runAuthenticatedStartAdminControl(context, getRequest(), (controls) =>
      controls.getTraitJournal(data),
    ),
  );
export const renameStartAdminSubject = createServerFn({ method: 'POST' })
  .inputValidator((input: Parameters<AdminControlClient['renameSubject']>[0]) => input)
  .handler(({ context, data }) =>
    runAuthenticatedStartAdminControl(context, getRequest(), (controls) =>
      controls.renameSubject(data),
    ),
  );
export const retireStartAdminSubject = createServerFn({ method: 'POST' })
  .inputValidator((input: Parameters<AdminControlClient['retireSubject']>[0]) => input)
  .handler(({ context, data }) =>
    runAuthenticatedStartAdminControl(context, getRequest(), (controls) =>
      controls.retireSubject(data),
    ),
  );
export const restoreStartAdminSubject = createServerFn({ method: 'POST' })
  .inputValidator((input: Parameters<AdminControlClient['restoreSubject']>[0]) => input)
  .handler(({ context, data }) =>
    runAuthenticatedStartAdminControl(context, getRequest(), (controls) =>
      controls.restoreSubject(data),
    ),
  );
export const resetStartAdminSubject = createServerFn({ method: 'POST' })
  .inputValidator((input: Parameters<AdminControlClient['resetSubject']>[0]) => input)
  .handler(({ context, data }) =>
    runAuthenticatedStartAdminControl(context, getRequest(), (controls) =>
      controls.resetSubject(data),
    ),
  );
export const validateStartAdminSubject = createServerFn({ method: 'POST' })
  .inputValidator((input: Parameters<AdminControlClient['validateSubject']>[0]) => input)
  .handler(({ context, data }) =>
    runAuthenticatedStartAdminControl(context, getRequest(), (controls) =>
      controls.validateSubject(data),
    ),
  );
export const editStartAdminSubjectTrait = createServerFn({ method: 'POST' })
  .inputValidator((input: Parameters<AdminControlClient['editSubjectTrait']>[0]) => input)
  .handler(({ context, data }) =>
    runAuthenticatedStartAdminControl(context, getRequest(), (controls) =>
      controls.editSubjectTrait(data),
    ),
  );
export const forkStartAdminSubjectTrait = createServerFn({ method: 'POST' })
  .inputValidator((input: Parameters<AdminControlClient['forkSubjectTrait']>[0]) => input)
  .handler(({ context, data }) =>
    runAuthenticatedStartAdminControl(context, getRequest(), (controls) =>
      controls.forkSubjectTrait(data),
    ),
  );
export const rebindStartAdminSubjectTrait = createServerFn({ method: 'POST' })
  .inputValidator((input: Parameters<AdminControlClient['rebindSubjectTrait']>[0]) => input)
  .handler(({ context, data }) =>
    runAuthenticatedStartAdminControl(context, getRequest(), (controls) =>
      controls.rebindSubjectTrait(data),
    ),
  );
export const editStartAdminSharedTrait = createServerFn({ method: 'POST' })
  .inputValidator((input: Parameters<AdminControlClient['editSharedTrait']>[0]) => input)
  .handler(({ context, data }) =>
    runAuthenticatedStartAdminControl(context, getRequest(), (controls) =>
      controls.editSharedTrait(data),
    ),
  );
export const rollbackStartAdminTrait = createServerFn({ method: 'POST' })
  .inputValidator((input: Parameters<AdminControlClient['rollbackTrait']>[0]) => input)
  .handler(({ context, data }) =>
    runAuthenticatedStartAdminControl(context, getRequest(), (controls) =>
      controls.rollbackTrait(data),
    ),
  );
export const resetStartAdminTraitToSeed = createServerFn({ method: 'POST' })
  .inputValidator((input: Parameters<AdminControlClient['resetTraitToSeed']>[0]) => input)
  .handler(({ context, data }) =>
    runAuthenticatedStartAdminControl(context, getRequest(), (controls) =>
      controls.resetTraitToSeed(data),
    ),
  );
