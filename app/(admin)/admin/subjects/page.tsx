'use client';

// M5-T4b (YUK-321) — 薄壳：AdminSubjectsSurface 真身已迁
// src/capabilities/observability/ui/subjects（SPA /admin/subjects；数据面改走
// /api/admin/subjects，旧纯 RSC 直读 registry 形态随迁移退役）。Task 9 整体删除。
import { AdminSubjectsSurface } from '@/capabilities/observability/ui/subjects';
import { useRouter } from 'next/navigation';

export default function AdminSubjectsPage() {
  const router = useRouter();
  return <AdminSubjectsSurface navigate={(to) => router.push(to)} />;
}
