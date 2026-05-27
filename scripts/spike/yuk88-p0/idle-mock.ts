import { type JsonDoc, replaceFirstTextInBlock } from './invariants';

type Presence = 'editing' | 'idle';

type Patch = {
  block_id: string;
  op: 'replace_content';
  new_content: string;
  queued_at_ms: number;
};

export class IdlePatchCoordinator {
  private presence: Presence = 'editing';
  private queue: Patch[] = [];

  constructor(
    private doc: JsonDoc,
    private readonly timeoutMs = 10 * 60 * 1000,
  ) {}

  heartbeat(presence: Presence) {
    this.presence = presence;
    if (presence === 'idle') this.flush();
  }

  enqueuePatch(patch: Omit<Patch, 'queued_at_ms'>, nowMs = Date.now()) {
    const queued = { ...patch, queued_at_ms: nowMs };
    if (this.presence === 'editing') {
      this.queue.push(queued);
      return { applied: false, reason: 'deferred:editing' as const };
    }
    this.apply(queued);
    return { applied: true, reason: 'applied:idle' as const };
  }

  forceFlushExpired(nowMs = Date.now()) {
    const expired = this.queue.filter((patch) => nowMs - patch.queued_at_ms >= this.timeoutMs);
    this.queue = this.queue.filter((patch) => nowMs - patch.queued_at_ms < this.timeoutMs);
    for (const patch of expired) this.apply(patch);
    return expired.length;
  }

  flush() {
    const pending = this.queue;
    this.queue = [];
    for (const patch of pending) this.apply(patch);
    return pending.length;
  }

  snapshot() {
    return {
      presence: this.presence,
      queued: this.queue.length,
      doc: this.doc,
    };
  }

  private apply(patch: Patch) {
    if (patch.op !== 'replace_content') {
      throw new Error(`unsupported patch op ${patch.op}`);
    }
    this.doc = replaceFirstTextInBlock(this.doc, patch.block_id, patch.new_content);
  }
}

export function assertIdleMock(doc: JsonDoc) {
  const coordinator = new IdlePatchCoordinator(doc, 10_000);
  const first = coordinator.enqueuePatch(
    {
      block_id: 'b_pitfall_1',
      op: 'replace_content',
      new_content: 'AI patch deferred while user is editing.',
    },
    0,
  );
  if (first.applied) throw new Error('editing patch should be deferred');
  if (coordinator.snapshot().queued !== 1) throw new Error('patch was not queued');

  coordinator.heartbeat('idle');
  const afterIdle = coordinator.snapshot();
  if (afterIdle.queued !== 0) throw new Error('idle heartbeat did not flush queue');

  coordinator.heartbeat('editing');
  coordinator.enqueuePatch(
    {
      block_id: 'b_check_1',
      op: 'replace_content',
      new_content: 'AI patch forced after timeout.',
    },
    0,
  );
  const forced = coordinator.forceFlushExpired(10_001);
  if (forced !== 1) throw new Error('timeout did not force flush expired patch');

  return {
    deferred: first,
    afterIdle,
    forced,
    afterForced: coordinator.snapshot(),
  };
}
