'use client';

// M5-T4b (YUK-321) — 薄壳：AdminFailuresSurface 真身已迁
// src/capabilities/observability/ui/observability（SPA /admin/failures）。Task 9 整体删除。
import { AdminFailuresSurface } from '@/capabilities/observability/ui/observability';
import { useRouter } from 'next/navigation';

export default function AdminFailuresPage() {
  const router = useRouter();
  return <AdminFailuresSurface navigate={(to) => router.push(to)} />;
}
