'use client';

// M5-T4b (YUK-321) — 薄壳：CoachPage 真身已迁 src/capabilities/shell/ui/CoachPage
// （SPA /coach）。本壳仅为旧栈过渡期保留，Task 9 整体删除。
import CoachPage from '@/capabilities/shell/ui/CoachPage';
import { useRouter } from 'next/navigation';

export default function CoachRoutePage() {
  const router = useRouter();
  return <CoachPage navigate={(to) => router.push(to)} />;
}
