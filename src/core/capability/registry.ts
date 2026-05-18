import type { CapabilityManifestT } from '@/core/schema/capability';
import type { JudgeCapabilityRunner } from './types';

export class CapabilityRegistry {
  private judges = new Map<string, JudgeCapabilityRunner>();

  registerJudge(runner: JudgeCapabilityRunner): void {
    const { id } = runner.manifest;
    if (this.judges.has(id)) {
      throw new Error(`Judge capability '${id}' already registered`);
    }
    this.judges.set(id, runner);
  }

  resolveJudge(id: string): JudgeCapabilityRunner | undefined {
    return this.judges.get(id);
  }

  hasJudge(id: string): boolean {
    return this.judges.has(id);
  }

  listJudges(): CapabilityManifestT[] {
    return [...this.judges.values()].map((runner) => runner.manifest);
  }
}
