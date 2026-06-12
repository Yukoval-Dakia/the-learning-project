'use client';

// M5-T4b (YUK-321) — 薄壳：AdminCostSurface 真身已迁
// src/capabilities/observability/ui/observability（SPA /admin/cost）。Task 9 整体删除。
import { AdminCostSurface } from '@/capabilities/observability/ui/observability';
import { useRouter } from 'next/navigation';

export default function AdminCostPage() {
  const router = useRouter();
  return <AdminCostSurface navigate={(to) => router.push(to)} />;
}
