-- YUK-1097 — backfill review 复审 3 条 P1（DB 层完整性补丁，均在 0105/0107
-- 已建立的 guard 先例上扩展）：
--
-- 1) evaluation_group.submission_ids ⇄ assessment_submission.evaluation_group_id
--    双写漂移：submission_ids 改为【DB 层成员关系派生缓存】——
--    a. submission INSERT 后 trigger 把 submission_id 追加进所属组数组
--       （幂等：已在数组内则 no-op；组 INSERT 的 declare-first 初始值不动）。
--    b. 组行 UPDATE 只允许【严格追加真实成员】：NEW = OLD ++ tail，即
--       OLD 是 NEW 的有序前缀（保序、不得移除/重排），且 tail 元素不得
--       重复（不含已声明成员）、且每个都必须是本组已存在的 submission
--       （同 tx 内新插成员对 trigger 可见）。移除/重排/幻影/重复 ⇒ P0001。身份坐标
--       （evaluation_group_id/created_at）同样冻结 —— 悬空组的 PK 改写
--       不受 FK 拦，也必须拒绝。
--    c. 组行 DELETE 一律拒绝（immutable_guard；成员 FK 之外的第二道防线）。
--    残余 gap（有意留档）：INSERT 时可声明尚不存在的成员（declare-first
--    计划模式必须允许），声明-兑现的一致性由迁移批内容对账覆盖，DB 层不做
--    跨事务悬空声明的延迟校验。
--
-- 2) assessment_identity_mapping 缺 immutability（0105 漏挂）：身份坐标
--    （kind/id/locator/original_question/legacy_part_ref）、裁决字段
--    （status/target_*/snapshot_digest）与 created_at 一旦写入即冻结；
--    可变的只有 is_current / supersedes_mapping_id（修正链）与 pending
--    占位行的 evidence/algorithm_version 操作性注释刷新（P1-5 契约，
--    apply.ts 唯一的原地写路径）。DELETE 一律拒绝 —— 历史裁决不可抹除。
--
-- 3) evaluation 无 terminal freeze：身份坐标全列冻结；status='completed'
--    后整行冻结（unit_results/aggregate/plan_digest/provenance/run_refs/
--    status）；pending 行只允许 pending→completed 终态写入携带载荷 —
--    pending→pending 的载荷改写拒绝（载荷只能随终态写一次）。
--    DELETE 一律拒绝（尝试记录不可抹除）。
--
-- restore 通道：全部新 UPDATE/DELETE guard 同样尊重
-- `SET LOCAL app.assessment_restore_mode = 'on'`（0107 建立的窄通道，
-- archive.ts 恢复事务与迁移对账测试的唯一穿越口；成员追加 trigger 不设
-- 旁路 —— 正确性 trigger，restore 重插时数组已完整故恒为 no-op）。

CREATE OR REPLACE FUNCTION "assessment_group_membership_append"() RETURNS trigger AS $$
BEGIN
  UPDATE "evaluation_group" g
  SET "submission_ids" = g."submission_ids" || to_jsonb(NEW."submission_id")
  WHERE g."evaluation_group_id" = NEW."evaluation_group_id"
    AND NOT (g."submission_ids" @> to_jsonb(NEW."submission_id"));
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "assessment_submission_group_membership"
  AFTER INSERT ON "assessment_submission"
  FOR EACH ROW EXECUTE FUNCTION "assessment_group_membership_append"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "assessment_group_membership_guard"() RETURNS trigger AS $$
DECLARE
  tail jsonb;
BEGIN
  IF current_setting('app.assessment_restore_mode', true) = 'on' THEN
    RETURN NEW;
  END IF;
  -- 身份坐标冻结（PK 无参照的悬空组也不得改写身份/时点）。
  IF NEW."evaluation_group_id" IS DISTINCT FROM OLD."evaluation_group_id"
     OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
  THEN
    RAISE EXCEPTION 'evaluation_group identity fields are frozen (YUK-1097)'
      USING ERRCODE = 'P0001';
  END IF;
  IF NEW."submission_ids" IS NOT DISTINCT FROM OLD."submission_ids" THEN
    RETURN NEW;
  END IF;
  -- 严格追加语义：OLD 必须是 NEW 的有序前缀 —— 移除与重排同样拒绝。
  IF jsonb_array_length(NEW."submission_ids") <= jsonb_array_length(OLD."submission_ids")
     OR EXISTS (
       SELECT 1 FROM jsonb_array_elements(OLD."submission_ids") WITH ORDINALITY AS o(elem, i)
       WHERE (NEW."submission_ids" -> ((o.i - 1)::int)) IS DISTINCT FROM o.elem
     )
  THEN
    RAISE EXCEPTION 'evaluation_group.submission_ids is append-only (YUK-1097): member removal or reorder is not allowed'
      USING ERRCODE = 'P0001';
  END IF;
  tail := (SELECT COALESCE(jsonb_agg(e.elem ORDER BY e.i), '[]'::jsonb)
           FROM jsonb_array_elements(NEW."submission_ids") WITH ORDINALITY AS e(elem, i)
           WHERE e.i > jsonb_array_length(OLD."submission_ids"));
  -- 追加段必须严格新增：不得重复已声明成员，也不得在尾内自我重复
  -- （成员关系派生缓存：重复 id 是脏缓存）。
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(tail) AS e(elem)
    WHERE (OLD."submission_ids" @> e.elem)
       OR (SELECT count(*) FROM jsonb_array_elements(tail) AS f(elem)
           WHERE f.elem = e.elem) > 1
  ) THEN
    RAISE EXCEPTION 'evaluation_group.submission_ids append must not duplicate members (YUK-1097)'
      USING ERRCODE = 'P0001';
  END IF;
  -- 新增元素必须是本组已存在的成员 submission。
  IF EXISTS (
    SELECT 1 FROM jsonb_array_elements(tail) AS e(elem)
    WHERE NOT EXISTS (
        SELECT 1 FROM "assessment_submission" s
        WHERE s."submission_id" = (e.elem #>> '{}')
          AND s."evaluation_group_id" = NEW."evaluation_group_id"
      )
  ) THEN
    RAISE EXCEPTION 'evaluation_group.submission_ids may only append real member submissions (YUK-1097)'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "evaluation_group_membership_frozen"
  BEFORE UPDATE ON "evaluation_group"
  FOR EACH ROW EXECUTE FUNCTION "assessment_group_membership_guard"();
--> statement-breakpoint
CREATE TRIGGER "evaluation_group_no_delete"
  BEFORE DELETE ON "evaluation_group"
  FOR EACH ROW EXECUTE FUNCTION "assessment_immutable_guard"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "assessment_identity_mapping_freeze_guard"() RETURNS trigger AS $$
BEGIN
  IF current_setting('app.assessment_restore_mode', true) = 'on' THEN
    RETURN NEW;
  END IF;
  -- 身份坐标 + 裁决字段 + created_at 一律冻结（修正链用新行，绝不原地改判）。
  IF NEW."mapping_id" IS DISTINCT FROM OLD."mapping_id"
     OR NEW."source_kind" IS DISTINCT FROM OLD."source_kind"
     OR NEW."source_id" IS DISTINCT FROM OLD."source_id"
     OR NEW."source_locator" IS DISTINCT FROM OLD."source_locator"
     OR NEW."original_question_id" IS DISTINCT FROM OLD."original_question_id"
     OR NEW."legacy_part_ref" IS DISTINCT FROM OLD."legacy_part_ref"
     OR NEW."snapshot_digest" IS DISTINCT FROM OLD."snapshot_digest"
     OR NEW."target_revision_id" IS DISTINCT FROM OLD."target_revision_id"
     OR NEW."target_part_id" IS DISTINCT FROM OLD."target_part_id"
     OR NEW."target_slot_id" IS DISTINCT FROM OLD."target_slot_id"
     OR NEW."status" IS DISTINCT FROM OLD."status"
     OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
  THEN
    RAISE EXCEPTION 'assessment_identity_mapping identity/adjudication fields are frozen (YUK-1097); corrections go through the supersedes chain'
      USING ERRCODE = 'P0001';
  END IF;
  -- pending 是未裁决占位：允许操作性注释刷新（evidence/algorithm_version，
  -- P1-5 契约）；已裁决行连注释也冻结。
  IF OLD."status" <> 'pending'
     AND (NEW."evidence" IS DISTINCT FROM OLD."evidence"
          OR NEW."algorithm_version" IS DISTINCT FROM OLD."algorithm_version")
  THEN
    RAISE EXCEPTION 'assessment_identity_mapping evidence/algorithm_version are frozen once adjudicated (YUK-1097)'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "assessment_identity_mapping_frozen"
  BEFORE UPDATE ON "assessment_identity_mapping"
  FOR EACH ROW EXECUTE FUNCTION "assessment_identity_mapping_freeze_guard"();
--> statement-breakpoint
CREATE TRIGGER "assessment_identity_mapping_no_delete"
  BEFORE DELETE ON "assessment_identity_mapping"
  FOR EACH ROW EXECUTE FUNCTION "assessment_immutable_guard"();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION "assessment_evaluation_freeze_guard"() RETURNS trigger AS $$
BEGIN
  IF current_setting('app.assessment_restore_mode', true) = 'on' THEN
    RETURN NEW;
  END IF;
  -- 身份坐标（含 attempt）一律冻结。
  IF NEW."evaluation_id" IS DISTINCT FROM OLD."evaluation_id"
     OR NEW."evaluation_group_id" IS DISTINCT FROM OLD."evaluation_group_id"
     OR NEW."submission_id" IS DISTINCT FROM OLD."submission_id"
     OR NEW."attempt" IS DISTINCT FROM OLD."attempt"
     OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
  THEN
    RAISE EXCEPTION 'evaluation identity coordinates are frozen (YUK-1097)'
      USING ERRCODE = 'P0001';
  END IF;
  -- 终态（status='completed'）后整行冻结 —— 判分结论是学习事实。
  IF OLD."status" <> 'pending' THEN
    IF NEW."status" IS DISTINCT FROM OLD."status"
       OR NEW."unit_results" IS DISTINCT FROM OLD."unit_results"
       OR NEW."aggregate" IS DISTINCT FROM OLD."aggregate"
       OR NEW."plan_digest" IS DISTINCT FROM OLD."plan_digest"
       OR NEW."run_refs" IS DISTINCT FROM OLD."run_refs"
       OR NEW."provenance" IS DISTINCT FROM OLD."provenance"
    THEN
      RAISE EXCEPTION 'evaluation is terminal-frozen (YUK-1097): result payload cannot be rewritten after completion'
        USING ERRCODE = 'P0001';
    END IF;
    RETURN NEW;
  END IF;
  -- pending 行：载荷只随 pending→completed 终态迁移写一次；
  -- pending→pending 只允许 run_refs/status 以外的空操作（即载荷必须不变）。
  IF NEW."status" IS NOT DISTINCT FROM OLD."status"
     AND (NEW."unit_results" IS DISTINCT FROM OLD."unit_results"
          OR NEW."aggregate" IS DISTINCT FROM OLD."aggregate"
          OR NEW."plan_digest" IS DISTINCT FROM OLD."plan_digest"
          OR NEW."provenance" IS DISTINCT FROM OLD."provenance")
  THEN
    RAISE EXCEPTION 'evaluation payload may only be written by the pending→terminal transition (YUK-1097)'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "evaluation_terminal_frozen"
  BEFORE UPDATE ON "evaluation"
  FOR EACH ROW EXECUTE FUNCTION "assessment_evaluation_freeze_guard"();
--> statement-breakpoint
CREATE TRIGGER "evaluation_no_delete"
  BEFORE DELETE ON "evaluation"
  FOR EACH ROW EXECUTE FUNCTION "assessment_immutable_guard"();
