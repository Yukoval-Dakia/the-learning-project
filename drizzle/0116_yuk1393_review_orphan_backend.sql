CREATE TABLE review_orphan_control (
  phase text NOT NULL CHECK (phase IN ('pg-boss','draining-pg-boss','dbos','draining-dbos')),
  phase_changed_at timestamptz NOT NULL DEFAULT now(),
  legacy_not_before timestamptz
);
CREATE UNIQUE INDEX review_orphan_control_singleton ON review_orphan_control ((true));
INSERT INTO review_orphan_control (phase) VALUES ('pg-boss');
--> statement-breakpoint
CREATE TABLE review_orphan_tick (
  tick_id text PRIMARY KEY,
  backend text NOT NULL CHECK (backend IN ('pg-boss','dbos')),
  provenance text NOT NULL CHECK (provenance IN ('scheduled','legacy-first-admission')),
  tick_at timestamptz NOT NULL,
  cutoff timestamptz NOT NULL,
  admission text NOT NULL CHECK (admission IN ('admitted','fenced')),
  candidates jsonb NOT NULL CHECK (jsonb_typeof(candidates) = 'array'),
  contract_version integer NOT NULL CHECK (contract_version = 1),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  CHECK (cutoff = tick_at - interval '6 hours'),
  CHECK ((backend = 'dbos') = (provenance = 'scheduled')),
  CHECK (admission <> 'fenced' OR candidates = '[]'::jsonb)
);
--> statement-breakpoint
CREATE TABLE review_orphan_receipt (
  tick_id text NOT NULL REFERENCES review_orphan_tick(tick_id),
  session_id text NOT NULL,
  outcome jsonb NOT NULL CHECK (outcome->>'kind' IS NOT NULL AND outcome->>'kind' IN ('abandoned','skipped','deferred-known-failure')),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tick_id, session_id)
);
--> statement-breakpoint
CREATE TABLE review_orphan_disposition (
  id text PRIMARY KEY,
  backend text NOT NULL CHECK (backend IN ('pg-boss','dbos')),
  task_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('terminal','quiescence')),
  observed_state text NOT NULL,
  reason text NOT NULL CHECK (length(trim(reason)) > 0),
  recorded_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE FUNCTION preserve_review_orphan_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'review orphan execution evidence is immutable';
END;
$$;
CREATE TRIGGER review_orphan_tick_immutable BEFORE UPDATE OR DELETE ON review_orphan_tick
  FOR EACH ROW EXECUTE FUNCTION preserve_review_orphan_evidence();
CREATE TRIGGER review_orphan_receipt_immutable BEFORE UPDATE OR DELETE ON review_orphan_receipt
  FOR EACH ROW EXECUTE FUNCTION preserve_review_orphan_evidence();
CREATE TRIGGER review_orphan_disposition_immutable BEFORE UPDATE OR DELETE ON review_orphan_disposition
  FOR EACH ROW EXECUTE FUNCTION preserve_review_orphan_evidence();
--> statement-breakpoint
-- Installed after pg-boss owns its schema. State updates of accepted jobs remain allowed.
CREATE FUNCTION fence_review_orphan_producer() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE current_phase text; not_before timestamptz;
BEGIN
  IF NEW.name = 'prune_orphan_review_sessions' THEN
    SELECT phase, legacy_not_before INTO STRICT current_phase, not_before
      FROM review_orphan_control FOR SHARE;
    IF current_phase <> 'pg-boss' OR not_before > clock_timestamp() THEN
      RAISE EXCEPTION 'review orphan pg-boss producer fenced: %', current_phase;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
