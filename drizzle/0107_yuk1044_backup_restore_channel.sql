--> statement-breakpoint
-- YUK-1044 CI 修复（PR #1466 Failure B）——
-- 不可变 trigger 与 backup restore wipe 的死锁：archive.ts 的 restore 在单事务内
-- `delete from "<table>"` 反序 wipe 再正序重插；assessment_immutable_guard 的
-- BEFORE DELETE 会让任何触及保护表的 restore 自锁。
-- 方案：给 guard 开一条【窄的、可信的 restore 通道】——事务内
-- `SET LOCAL app.assessment_restore_mode = 'on'`（archive.ts 恢复事务专用；
-- SET LOCAL 事务结束自动失效）。生产威胁模型不变：普通 writer 不发 SET LOCAL，
-- guard 行为逐字节不变；只有能在特权恢复事务内执行 SET LOCAL 的代码可穿越，
-- 而这类代码本就能 TRUNCATE（resetDb 先例）。无此 GUC 时 guard 照常拒绝。
CREATE OR REPLACE FUNCTION "assessment_immutable_guard"() RETURNS trigger AS $$
BEGIN
  IF current_setting('app.assessment_restore_mode', true) = 'on' THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'table % is append-only/immutable (YUK-1044): % is not allowed', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'P0001';
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE OR REPLACE FUNCTION "assessment_issuance_freeze_guard"() RETURNS trigger AS $$
BEGIN
  IF current_setting('app.assessment_restore_mode', true) = 'on' THEN
    RETURN NEW;
  END IF;
  IF NEW.issuance_id IS DISTINCT FROM OLD.issuance_id
     OR NEW.revision_id IS DISTINCT FROM OLD.revision_id
     OR NEW.part_ids IS DISTINCT FROM OLD.part_ids
     OR NEW.material_bindings IS DISTINCT FROM OLD.material_bindings
     OR NEW.option_order IS DISTINCT FROM OLD.option_order
     OR NEW.container_occurrence_ref IS DISTINCT FROM OLD.container_occurrence_ref
     OR NEW.issued_at IS DISTINCT FROM OLD.issued_at
     OR NEW.claim_policy IS DISTINCT FROM OLD.claim_policy
  THEN
    RAISE EXCEPTION 'assessment_issuance binding fields are frozen (YUK-1044); only claim lifecycle columns may change'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
-- YUK-1044 CI 修复（restore 插入序鲁棒性）—— assessment_identity_mapping 的
-- supersedes 自 FK（0105 建，名被 PG 截断为 63 字节）设为 DEFERRABLE INITIALLY
-- IMMEDIATE：日常写路径行为不变（立即检查）；archive.ts 恢复事务用
-- SET CONSTRAINTS ALL DEFERRED 把它推迟到 commit —— backup dump 的同表行序
-- 不保证父（被链）行先于子行，不推迟会中途违约。drizzle-kit 不 diff
-- deferrability，快照无漂移。
ALTER TABLE "assessment_identity_mapping"
  ALTER CONSTRAINT "assessment_identity_mapping_supersedes_mapping_id_assessment_id"
  DEFERRABLE INITIALLY IMMEDIATE;
