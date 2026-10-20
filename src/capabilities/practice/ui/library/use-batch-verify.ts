import { useState } from 'react';
import { showToast } from '@/ui-next/public';
import { useVerifyDraft } from './use-question-writes';

export interface BatchProgress {
  done: number;
  total: number;
}

/**
 * Verify several drafts one after another (each check can take a while). A draft that passes is
 * turned on and leaves the list; one that fails stays, with the reason on its row.
 */
export function useBatchVerify(onFinished: () => void) {
  const verify = useVerifyDraft();
  const [progress, setProgress] = useState<BatchProgress | null>(null);

  const run = async (ids: readonly string[]) => {
    if (progress || ids.length === 0) return;
    let passed = 0;
    let failed = 0;
    let errors = 0;
    setProgress({ done: 0, total: ids.length });
    for (const [index, id] of ids.entries()) {
      try {
        const result = await verify.mutateAsync(id);
        if (result.promoted) passed += 1;
        else failed += 1;
      } catch {
        errors += 1;
      }
      setProgress({ done: index + 1, total: ids.length });
    }
    setProgress(null);
    onFinished();
    const parts = [
      passed > 0 && `${passed} 道通过，已开始出题`,
      failed > 0 && `${failed} 道没通过，留在这里并写了原因`,
      errors > 0 && `${errors} 道没能核验，可以再试`,
    ].filter(Boolean);
    showToast({ message: parts.join('；') || '没有核验任何题' });
  };

  return { run, progress };
}
