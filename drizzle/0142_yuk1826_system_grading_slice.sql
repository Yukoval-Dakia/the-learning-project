-- Refuse to broaden or erase any existing subject-specific approvals.
-- Keep the emptiness check and DDL under one lock, including autocommit runners.
DO $$ BEGIN
  LOCK TABLE "model_admission_slice" IN ACCESS EXCLUSIVE MODE;
  IF EXISTS (SELECT 1 FROM "model_admission_slice") THEN
    RAISE EXCEPTION 'system grading slices require an empty registry; preserve and adjudicate existing slices first';
  END IF;
  DROP INDEX "model_admission_slice_lookup_idx";
  DROP INDEX "model_admission_slice_natural_key";
  CREATE INDEX "model_admission_slice_lookup_idx" ON "model_admission_slice" ("response_class","task_kind");
  CREATE UNIQUE INDEX "model_admission_slice_natural_key" ON "model_admission_slice" ("response_class","task_kind","model","model_version");
  ALTER TABLE "model_admission_slice" DROP COLUMN "subject";
END $$;
