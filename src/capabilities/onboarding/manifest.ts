import { defineCapability } from '@/kernel/manifest';
import { uiPagesFor } from '@/kernel/ui-surfaces';

// YUK-329 — onboarding 早已是 shipped SPA capability，但此前未进入静态组合根，
// 导致 welcome/upload/placement/profile 四面无法参与 ui.pages 对账。
export const onboardingCapability = defineCapability({
  name: 'onboarding',
  description: '冷启动引导：目标设定、学习材料上传、起点探测与起始档案。',
  ui: { pages: uiPagesFor('onboarding') },
});
