-- Never broaden existing subject-specific approvals or erase their provenance.
-- Production must confirm the expected empty registry before this migration.
LOCK TABLE "model_admission_slice" IN ACCESS EXCLUSIVE MODE;
--> statement-breakpoint
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM "model_admission_slice") THEN
    RAISE EXCEPTION 'system grading slices require an empty registry; preserve and adjudicate existing slices first';
  END IF;
END $$;
--> statement-breakpoint
DROP INDEX "model_admission_slice_lookup_idx";--> statement-breakpoint
DROP INDEX "model_admission_slice_natural_key";--> statement-breakpoint
CREATE INDEX "model_admission_slice_lookup_idx" ON "model_admission_slice" USING btree ("response_class","task_kind");--> statement-breakpoint
CREATE UNIQUE INDEX "model_admission_slice_natural_key" ON "model_admission_slice" USING btree ("response_class","task_kind","model","model_version");--> statement-breakpoint
ALTER TABLE "model_admission_slice" DROP COLUMN "subject";