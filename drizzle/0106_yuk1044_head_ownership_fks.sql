ALTER TABLE "assessment_identity_mapping" DROP CONSTRAINT "assessment_identity_mapping_locator_nonempty_ck";
--> statement-breakpoint
ALTER TABLE "evaluation_effective_head" DROP CONSTRAINT "evaluation_effective_head_evaluation_fk";
--> statement-breakpoint
DROP INDEX "evaluation_id_group_uq";
--> statement-breakpoint
CREATE UNIQUE INDEX "evaluation_id_submission_group_uq" ON "evaluation" USING btree ("evaluation_id","submission_id","evaluation_group_id");
--> statement-breakpoint
ALTER TABLE "evaluation_effective_head" ADD CONSTRAINT "evaluation_effective_head_submission_fk" FOREIGN KEY ("submission_id","evaluation_group_id") REFERENCES "public"."assessment_submission"("submission_id","evaluation_group_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "evaluation_effective_head" ADD CONSTRAINT "evaluation_effective_head_evaluation_fk" FOREIGN KEY ("effective_evaluation_id","submission_id","evaluation_group_id") REFERENCES "public"."evaluation"("evaluation_id","submission_id","evaluation_group_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "assessment_identity_mapping" ADD CONSTRAINT "assessment_identity_mapping_locator_nonempty_ck" CHECK (btrim("assessment_identity_mapping"."source_locator") <> '');
--> statement-breakpoint
-- P2（终验）— claim_policy 收入 issuance 冻结列：policy 是发题时选定的
-- serve 契约一部分（one_time/unbounded 决定 claim 语义），事后改写会静默
-- 变更契约，故与绑定列同样冻结。CREATE OR REPLACE 保持同名同签名 ——
-- 0105 已建的 assessment_issuance_binding_frozen trigger 绑定同一函数 OID，
-- 替换函数体即生效，无需重建 trigger。可变列只剩 claim_status/claimed_by_ref。
CREATE OR REPLACE FUNCTION "assessment_issuance_freeze_guard"() RETURNS trigger AS $$
BEGIN
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
$$ LANGUAGE plpgsql;
