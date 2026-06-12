// 静态组合根 —— 架构重设计的「迁移进度表」（spec §2.1，YUK-311）。
// 每迁入一个 capability 包就在此登记一行；composition.unit.test.ts 跑
// validateComposition 保证包名 / event action / 路由声明全局无冲突。
// 反框架护栏：静态数组、类型检查、无动态加载。
import type { CapabilityManifest } from '@/kernel/manifest';
import { agencyCapability } from './agency/manifest';
import { copilotCapability } from './copilot/manifest';
import { ingestionCapability } from './ingestion/manifest';
import { knowledgeCapability } from './knowledge/manifest';
import { notesCapability } from './notes/manifest';
import { observabilityCapability } from './observability/manifest';
import { practiceCapability } from './practice/manifest';
import { shellCapability } from './shell/manifest';

export const capabilities: CapabilityManifest[] = [
  agencyCapability,
  ingestionCapability,
  practiceCapability,
  knowledgeCapability,
  notesCapability,
  copilotCapability,
  observabilityCapability,
  shellCapability,
];
