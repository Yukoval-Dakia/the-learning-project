import type {
  CapabilityManifestT,
  JudgeResultV2T,
} from '@/core/schema/capability';

export interface JudgeRunInput {
  question: Record<string, unknown>;
  answer: { content: string };
}

export interface JudgeCapabilityRunner {
  readonly manifest: CapabilityManifestT;
  run(input: JudgeRunInput): JudgeResultV2T;
}
