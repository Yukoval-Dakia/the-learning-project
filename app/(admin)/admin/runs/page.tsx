'use client';

// M5-T4b (YUK-321) — 薄壳：AdminRunsSurface 真身已迁
// src/capabilities/observability/ui/observability（SPA /admin/runs）。Task 9 整体删除。
import { AdminRunsSurface } from '@/capabilities/observability/ui/observability';
import { useRouter } from 'next/navigation';

export default function AdminRunsPage() {
  const router = useRouter();
  return <AdminRunsSurface navigate={(to) => router.push(to)} />;
}
