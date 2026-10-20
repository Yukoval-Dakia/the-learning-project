import { defineCapability } from '@/kernel/manifest';
import { uiPagesFor } from '@/kernel/ui-surfaces';

// Welcome, upload, placement, and profile stay in the static composition root,
// or ui.pages cannot reconcile them.
export const onboardingCapability = defineCapability({
  name: 'onboarding',
  description: '冷启动引导：目标设定、学习材料上传、起点探测与起始档案。',
  ui: { pages: uiPagesFor('onboarding') },
});
