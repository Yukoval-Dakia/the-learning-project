-- A candidate freezes the complete group input. Serialize direct SQL with the
-- application group lock; an acknowledged member is never removed or rewritten.
-- Existing rows are not backfilled. Restore retains its established narrow bypass.
CREATE OR REPLACE FUNCTION "assessment_group_input_seal_guard"() RETURNS trigger AS $$
BEGIN
  IF current_setting('app.assessment_restore_mode', true) = 'on' THEN
    RETURN NEW;
  END IF;
  PERFORM pg_advisory_xact_lock(hashtext('assessment-evaluation-group'), hashtext(NEW.evaluation_group_id));
  IF TG_TABLE_NAME = 'assessment_submission'
     AND EXISTS (SELECT 1 FROM evaluation WHERE evaluation_group_id = NEW.evaluation_group_id)
     AND NOT EXISTS (SELECT 1 FROM assessment_submission WHERE submission_id = NEW.submission_id)
  THEN
    RAISE EXCEPTION 'evaluation group input is frozen; new answers require a new attempt group (YUK-1091)'
      USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER "assessment_submission_input_sealed"
  BEFORE INSERT ON "assessment_submission"
  FOR EACH ROW EXECUTE FUNCTION "assessment_group_input_seal_guard"();
--> statement-breakpoint
CREATE TRIGGER "assessment_evaluation_input_serialized"
  BEFORE INSERT ON "evaluation"
  FOR EACH ROW EXECUTE FUNCTION "assessment_group_input_seal_guard"();
