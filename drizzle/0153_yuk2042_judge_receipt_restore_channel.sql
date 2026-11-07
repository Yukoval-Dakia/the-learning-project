-- 0107 建立的同一窄恢复通道：archive.ts 恢复事务在 wipe+重插前发
-- `SET LOCAL app.assessment_restore_mode = 'on'`（事务结束自动失效）。
-- event 在恢复 wipe/insert 范围内，不补这个检查的不可变触发器会挡住
-- 整库恢复。威胁模型不变：普通写入不发这个 SET LOCAL，判分收据不可变
-- 行为逐字节不变；能在特权恢复事务内发 SET LOCAL 的代码本就能 TRUNCATE。
CREATE OR REPLACE FUNCTION preserve_judge_operational_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF current_setting('app.assessment_restore_mode', true) = 'on' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF OLD.action IN ('experimental:judge_execution_binding','experimental:judge_delivery_reserved','experimental:judge_delivery_send',
    'experimental:judge_delivery_rejected','experimental:judge_delivery_accepted','experimental:judge_delivery_started',
    'experimental:judge_disposition','experimental:judge_ownership','experimental:judge_family_transition','experimental:judge_reconcile_observation') THEN
    RAISE EXCEPTION 'judge operational receipts are immutable';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
