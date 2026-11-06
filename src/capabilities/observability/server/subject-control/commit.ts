// subject 控制面写事务的唯一提交入口：取全局控制面锁、推进 subject.revision、
// 写 subject_control_journal。
//
// withControlPlane 开事务并以取锁为第一条语句；记账函数只收它给出的
// ControlPlaneTx，所以锁外记账在类型上不成立。journal.revision 恒等于本次写入的
// subject.revision。CAS（expectedRevision 比对）仍由各写面在锁内做，因为陈旧结果
// 的形状（axis 等）属于各写面自己的契约。

import { eq } from 'drizzle-orm';
import type { Db, Tx } from '@/db/client';
import { subject, subject_control_journal } from '@/db/schema';
import { acquireControlPlaneLockSql } from '@/kernel/records/subject-control-lock';

declare const controlPlaneLocked: unique symbol;
export type ControlPlaneTx = Tx & { readonly [controlPlaneLocked]: true };

type JournalRow = typeof subject_control_journal.$inferInsert;
type SubjectRow = typeof subject.$inferInsert;

export async function withControlPlane<T>(
  db: Db,
  fn: (tx: ControlPlaneTx) => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(acquireControlPlaneLockSql);
    return fn(tx as ControlPlaneTx);
  });
}

/** 锁内已读到 subject 行处于 fromRevision；推进一版并记 owner 账，返回新 revision。 */
export async function commitSubjectRevision(
  tx: ControlPlaneTx,
  args: {
    subjectId: string;
    fromRevision: number;
    action: Exclude<JournalRow['action'], 'create'>;
    detail: JournalRow['detail'];
    now: Date;
    patch?: Pick<Partial<SubjectRow>, 'display_name' | 'display_name_norm' | 'retired_at'>;
  },
): Promise<number> {
  const revision = args.fromRevision + 1;
  await tx
    .update(subject)
    .set({ ...args.patch, revision, updated_at: args.now })
    .where(eq(subject.id, args.subjectId));
  await tx.insert(subject_control_journal).values({
    subject_id: args.subjectId,
    revision,
    action: args.action,
    detail: args.detail,
    actor: 'owner',
    created_at: args.now,
  });
  return revision;
}

/**
 * 新控制行（rev 0）与 'create' 记账同写，返回是否真插入。ifMissing：id 已存在则
 * 两者都不写，重跑零副作用；否则唯一约束冲突照常抛给调用方。
 */
export async function insertSubjectRow(
  tx: ControlPlaneTx,
  args: {
    row: Omit<SubjectRow, 'revision' | 'created_at' | 'updated_at'>;
    actor: JournalRow['actor'];
    now: Date;
    ifMissing?: boolean;
    /** create 的 provenance；管理面缺省 {}。 */
    detail?: JournalRow['detail'];
  },
): Promise<boolean> {
  const values = { ...args.row, revision: 0, created_at: args.now, updated_at: args.now };
  const journal: JournalRow = {
    subject_id: args.row.id,
    revision: 0,
    action: 'create',
    detail: args.detail ?? {},
    actor: args.actor,
    created_at: args.now,
  };
  if (args.ifMissing) {
    const inserted = await tx
      .insert(subject)
      .values(values)
      .onConflictDoNothing({ target: subject.id })
      .returning({ id: subject.id });
    if (inserted.length === 0) return false;
    await tx.insert(subject_control_journal).values(journal).onConflictDoNothing();
    return true;
  }
  await tx.insert(subject).values(values);
  await tx.insert(subject_control_journal).values(journal);
  return true;
}
