ALTER TABLE "assessment_identity_mapping" ADD COLUMN "is_current" boolean DEFAULT true NOT NULL;
--> statement-breakpoint
ALTER TABLE "question_group_lifecycle" ADD COLUMN "scoring_admission_withheld_reason" text;
--> statement-breakpoint
ALTER TABLE "question_group_lifecycle" ADD COLUMN "scoring_admission_decided_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "assessment_identity_mapping" DROP CONSTRAINT "assessment_identity_mapping_status_ck";
--> statement-breakpoint
-- YUK-1044 复审 P1-1/P2-A —
-- 1) DROP 0104 手写的旧活跃映射索引（不在任何 snapshot 中，drizzle 不会自动
--    DROP）；其职责由上方声明式 assessment_identity_mapping_current_uq
--    （WHERE is_current，P1-3 选择位）取代。
DROP INDEX "assessment_identity_mapping_active_uq";
--> statement-breakpoint
CREATE UNIQUE INDEX "assessment_identity_mapping_current_uq" ON "assessment_identity_mapping" USING btree ("source_kind","source_id","source_locator") WHERE "assessment_identity_mapping"."is_current";
--> statement-breakpoint
CREATE UNIQUE INDEX "assessment_issuance_id_revision_uq" ON "assessment_issuance" USING btree ("issuance_id","revision_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "assessment_submission_id_group_uq" ON "assessment_submission" USING btree ("submission_id","evaluation_group_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "evaluation_id_group_uq" ON "evaluation" USING btree ("evaluation_id","evaluation_group_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "question_revision_group_id_uq" ON "question_revision" USING btree ("group_id","revision_id");
--> statement-breakpoint
ALTER TABLE "assessment_identity_mapping" ADD CONSTRAINT "assessment_identity_mapping_supersedes_mapping_id_assessment_identity_mapping_mapping_id_fk" FOREIGN KEY ("supersedes_mapping_id") REFERENCES "public"."assessment_identity_mapping"("mapping_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "assessment_identity_mapping" ADD CONSTRAINT "assessment_identity_mapping_target_revision_fk" FOREIGN KEY ("target_revision_id") REFERENCES "public"."question_revision"("revision_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "assessment_issuance" ADD CONSTRAINT "assessment_issuance_revision_fk" FOREIGN KEY ("revision_id") REFERENCES "public"."question_revision"("revision_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "assessment_submission" ADD CONSTRAINT "assessment_submission_group_fk" FOREIGN KEY ("evaluation_group_id") REFERENCES "public"."evaluation_group"("evaluation_group_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "assessment_submission" ADD CONSTRAINT "assessment_submission_issuance_revision_fk" FOREIGN KEY ("issuance_id","revision_id") REFERENCES "public"."assessment_issuance"("issuance_id","revision_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "evaluation" ADD CONSTRAINT "evaluation_submission_group_fk" FOREIGN KEY ("submission_id","evaluation_group_id") REFERENCES "public"."assessment_submission"("submission_id","evaluation_group_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "evaluation_effective_head" ADD CONSTRAINT "evaluation_effective_head_evaluation_fk" FOREIGN KEY ("effective_evaluation_id","evaluation_group_id") REFERENCES "public"."evaluation"("evaluation_id","evaluation_group_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "question_admission_verification" ADD CONSTRAINT "question_admission_verification_revision_fk" FOREIGN KEY ("revision_id") REFERENCES "public"."question_revision"("revision_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "question_group_lifecycle" ADD CONSTRAINT "question_group_lifecycle_current_revision_fk" FOREIGN KEY ("group_id","current_revision_id") REFERENCES "public"."question_revision"("group_id","revision_id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "assessment_identity_mapping" ADD CONSTRAINT "assessment_identity_mapping_locator_nonempty_ck" CHECK ("assessment_identity_mapping"."source_locator" <> '');
--> statement-breakpoint
ALTER TABLE "assessment_identity_mapping" ADD CONSTRAINT "assessment_identity_mapping_mapped_target_ck" CHECK (("assessment_identity_mapping"."status" <> 'mapped' OR "assessment_identity_mapping"."target_revision_id" IS NOT NULL));
--> statement-breakpoint
ALTER TABLE "assessment_identity_mapping" ADD CONSTRAINT "assessment_identity_mapping_unresolved_no_target_ck" CHECK (("assessment_identity_mapping"."status" <> 'historical_unresolved' OR "assessment_identity_mapping"."target_revision_id" IS NULL));
--> statement-breakpoint
ALTER TABLE "assessment_identity_mapping" ADD CONSTRAINT "assessment_identity_mapping_status_ck" CHECK ("assessment_identity_mapping"."status" IN ('pending','mapped','conflicted','historical_unresolved'));
--> statement-breakpoint
ALTER TABLE "question_group_lifecycle" ADD CONSTRAINT "question_group_lifecycle_withheld_reason_ck" CHECK ("question_group_lifecycle"."scoring_admission_withheld_reason" IN ('unverified_rules','verification_failed','no_admitted_executor','owner_hold'));
--> statement-breakpoint
ALTER TABLE "question_group_lifecycle" ADD CONSTRAINT "question_group_lifecycle_admission_branch_ck" CHECK (("question_group_lifecycle"."scoring_admission_state" = 'withheld' OR ("question_group_lifecycle"."scoring_admission_decided_at" IS NOT NULL AND "question_group_lifecycle"."scoring_admission_evidence" IS NOT NULL)) AND ("question_group_lifecycle"."scoring_admission_state" = 'admitted' OR "question_group_lifecycle"."scoring_admission_withheld_reason" IS NOT NULL));
--> statement-breakpoint
-- 2) P1-1 不可变事实的 DB 层防线：缺 updated_at 不构成不可变性 ——
--    BEFORE UPDATE/DELETE trigger 直接拒绝。覆盖：question_revision
--    （发布事实全行）、question_admission_verification（append-only）、
--    assessment_submission（冻结作答，D5 零丢失）。
CREATE OR REPLACE FUNCTION "assessment_immutable_guard"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'table % is append-only/immutable (YUK-1044): % is not allowed', TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'P0001';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "question_revision_immutable"
  BEFORE UPDATE OR DELETE ON "question_revision"
  FOR EACH ROW EXECUTE FUNCTION "assessment_immutable_guard"();
--> statement-breakpoint
CREATE TRIGGER "question_admission_verification_immutable"
  BEFORE UPDATE OR DELETE ON "question_admission_verification"
  FOR EACH ROW EXECUTE FUNCTION "assessment_immutable_guard"();
--> statement-breakpoint
CREATE TRIGGER "assessment_submission_immutable"
  BEFORE UPDATE OR DELETE ON "assessment_submission"
  FOR EACH ROW EXECUTE FUNCTION "assessment_immutable_guard"();
--> statement-breakpoint
-- 3) P1-1 issuance 列级冻结：绑定列（revision/parts/materials/order/
--    container_ref/issued_at）UPDATE 即拒绝；claim 列（claim_status/
--    claimed_by_ref）保持可变（一次性 claim 生命周期）。DELETE 一律拒绝
--    （发题事实是永久 serve 记录）。
CREATE OR REPLACE FUNCTION "assessment_issuance_freeze_guard"() RETURNS trigger AS $$
BEGIN
  IF NEW.issuance_id IS DISTINCT FROM OLD.issuance_id
     OR NEW.revision_id IS DISTINCT FROM OLD.revision_id
     OR NEW.part_ids IS DISTINCT FROM OLD.part_ids
     OR NEW.material_bindings IS DISTINCT FROM OLD.material_bindings
     OR NEW.option_order IS DISTINCT FROM OLD.option_order
     OR NEW.container_occurrence_ref IS DISTINCT FROM OLD.container_occurrence_ref
     OR NEW.issued_at IS DISTINCT FROM OLD.issued_at
  THEN
    RAISE EXCEPTION 'assessment_issuance binding fields are frozen (YUK-1044); only claim columns may change'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "assessment_issuance_binding_frozen"
  BEFORE UPDATE ON "assessment_issuance"
  FOR EACH ROW EXECUTE FUNCTION "assessment_issuance_freeze_guard"();
--> statement-breakpoint
CREATE TRIGGER "assessment_issuance_no_delete"
  BEFORE DELETE ON "assessment_issuance"
  FOR EACH ROW EXECUTE FUNCTION "assessment_immutable_guard"();
