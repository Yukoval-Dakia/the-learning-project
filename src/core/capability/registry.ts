import type { CapabilityManifestT } from '@/core/schema/capability';
import type { SchedulerCapabilityRunner } from './schedulers/types';
import type { JudgeCapabilityRunner } from './types';

export class CapabilityRegistry {
  private judges = new Map<string, JudgeCapabilityRunner>();
  // T-QP (YUK-165, ADR-0014 §5) — scheduler half of the registry.
  private schedulers = new Map<string, SchedulerCapabilityRunner>();

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

  registerScheduler(runner: SchedulerCapabilityRunner): void {
    const { id } = runner.manifest;
    if (this.schedulers.has(id)) {
      throw new Error(`Scheduler capability '${id}' already registered`);
    }
    this.schedulers.set(id, runner);
  }

  resolveScheduler(id: string): SchedulerCapabilityRunner | undefined {
    return this.schedulers.get(id);
  }

  hasScheduler(id: string): boolean {
    return this.schedulers.has(id);
  }

  listSchedulers(): CapabilityManifestT[] {
    return [...this.schedulers.values()].map((runner) => runner.manifest);
  }
}
