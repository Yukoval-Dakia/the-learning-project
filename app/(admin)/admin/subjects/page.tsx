import { AdminSubjectsSurface } from '@/ui/admin/subjects';

// Thin RSC wrapper (mirrors runs/page.tsx's server form) → the read-only registry
// surface. U7 (YUK-203).
export default function AdminSubjectsPage() {
  return <AdminSubjectsSurface />;
}
