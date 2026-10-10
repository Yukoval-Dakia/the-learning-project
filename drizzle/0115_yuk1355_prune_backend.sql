-- Default preserves the deployed scheduler until an explicit family cutover.
CREATE TABLE prune_job_events_control (
  phase text NOT NULL CHECK (phase IN ('pg-boss','draining-pg-boss','dbos','draining-dbos'))
);
CREATE UNIQUE INDEX prune_job_events_control_singleton ON prune_job_events_control ((true));
INSERT INTO prune_job_events_control (phase) VALUES ('pg-boss');
--> statement-breakpoint
CREATE TABLE prune_job_events_receipt (
  workflow_id text PRIMARY KEY,
  cutoff timestamptz NOT NULL,
  deleted integer NOT NULL CHECK (deleted >= 0)
);
--> statement-breakpoint
CREATE TABLE prune_job_events_disposition (
  backend text NOT NULL CHECK (backend IN ('pg-boss','dbos')),
  task_id text NOT NULL,
  observed_state text NOT NULL,
  reason text NOT NULL CHECK (length(trim(reason)) > 0),
  PRIMARY KEY (backend, task_id)
);
--> statement-breakpoint
-- Installed on pg-boss-owned tables by the worker after pg-boss creates them.
-- The row lock fences even older producers that retain a cached cron schedule.
CREATE FUNCTION fence_prune_job_events_producer() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE current_phase text;
BEGIN
  IF NEW.name = 'prune_job_events' THEN
    SELECT phase INTO STRICT current_phase FROM prune_job_events_control
      FOR SHARE;
    IF current_phase <> 'pg-boss' THEN
      RAISE EXCEPTION 'prune_job_events pg-boss producer fenced: %', current_phase;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
