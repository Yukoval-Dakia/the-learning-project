import { createFileRoute } from '@tanstack/react-router';
import { Suspense, lazy } from 'react';
import { loadAdminSubjectTraitsSurface } from '@/capabilities/observability/ui-public';
import { startAdminControlClient } from '../admin-control-client';
import { StartWorkbenchShell, startNavigate } from '../workbench-shell';

const Page = lazy(() =>
  loadAdminSubjectTraitsSurface().then((defaultPage) => ({ default: defaultPage })),
);
export const Route = createFileRoute('/admin/subjects/$id')({ ssr: false, component: SubjectPage });
function SubjectPage() {
  const { id } = Route.useParams();
  return (
    <StartWorkbenchShell pathname={`/admin/subjects/${id}`}>
      <Suspense>
        <Page subjectId={id} navigate={startNavigate} client={startAdminControlClient} />
      </Suspense>
    </StartWorkbenchShell>
  );
}
