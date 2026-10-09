CREATE TABLE session_orphan_control (
  family text PRIMARY KEY CHECK (family IN ('prune_orphan_conversation_sessions','prune_orphan_placement_sessions')),
  phase text NOT NULL CHECK (phase IN ('pg-boss','draining-pg-boss','dbos','draining-dbos')),
  phase_changed_at timestamptz NOT NULL DEFAULT now(),
  legacy_not_before timestamptz
);
INSERT INTO session_orphan_control (family,phase) VALUES
  ('prune_orphan_conversation_sessions','pg-boss'), ('prune_orphan_placement_sessions','pg-boss');
--> statement-breakpoint
CREATE TABLE session_orphan_tick (
  family text NOT NULL REFERENCES session_orphan_control(family) CHECK (family IN ('prune_orphan_conversation_sessions','prune_orphan_placement_sessions')),
  tick_id text NOT NULL,
  backend text NOT NULL CHECK (backend IN ('pg-boss','dbos')),
  provenance text NOT NULL CHECK (provenance IN ('scheduled','legacy-first-admission')),
  tick_at timestamptz NOT NULL,
  cutoff timestamptz NOT NULL,
  admission text NOT NULL CHECK (admission IN ('admitted','fenced')),
  candidates jsonb NOT NULL CHECK (jsonb_typeof(candidates) = 'array'),
  contract_version integer NOT NULL CHECK (contract_version = 1),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (family,tick_id),
  CHECK (cutoff = tick_at - interval '6 hours'),
  CHECK ((backend = 'dbos') = (provenance = 'scheduled')),
  CHECK (admission <> 'fenced' OR candidates = '[]'::jsonb)
);
--> statement-breakpoint
CREATE TABLE session_orphan_receipt (
  family text NOT NULL CHECK (family IN ('prune_orphan_conversation_sessions','prune_orphan_placement_sessions')),
  tick_id text NOT NULL,
  session_id text NOT NULL,
  outcome jsonb NOT NULL CHECK (outcome->>'kind' IS NOT NULL AND outcome->>'kind' IN ('abandoned','skipped','deferred-known-failure')),
  recorded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (family,tick_id,session_id),
  FOREIGN KEY (family,tick_id) REFERENCES session_orphan_tick(family,tick_id)
);
--> statement-breakpoint
CREATE TABLE session_orphan_disposition (
  family text NOT NULL REFERENCES session_orphan_control(family) CHECK (family IN ('prune_orphan_conversation_sessions','prune_orphan_placement_sessions')),
  id text NOT NULL,
  backend text NOT NULL CHECK (backend IN ('pg-boss','dbos')),
  kind text NOT NULL CHECK (kind IN ('terminal-task','terminal-row','quiescence')),
  observed_state text NOT NULL,
  reason text NOT NULL CHECK (length(trim(reason)) > 0),
  task_id text,
  tick_id text,
  session_id text,
  barrier_at timestamptz,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (family,id),
  FOREIGN KEY (family,tick_id) REFERENCES session_orphan_tick(family,tick_id),
  CHECK (
    (kind = 'terminal-task' AND length(task_id) > 0 AND tick_id IS NULL AND session_id IS NULL AND barrier_at IS NULL) OR
    (kind = 'terminal-row' AND length(task_id) > 0 AND length(tick_id) > 0 AND length(session_id) > 0 AND barrier_at IS NULL) OR
    (kind = 'quiescence' AND task_id IS NULL AND tick_id IS NULL AND session_id IS NULL AND barrier_at IS NOT NULL)
  ),
  CHECK ((kind = 'quiescence') OR task_id IS NOT NULL),
  CHECK ((kind <> 'terminal-row') OR (tick_id IS NOT NULL AND session_id IS NOT NULL))
);
--> statement-breakpoint
CREATE FUNCTION preserve_session_orphan_evidence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'session orphan execution evidence is immutable';
END;
$$;
CREATE TRIGGER session_orphan_tick_immutable BEFORE UPDATE OR DELETE ON session_orphan_tick
  FOR EACH ROW EXECUTE FUNCTION preserve_session_orphan_evidence();
CREATE TRIGGER session_orphan_receipt_immutable BEFORE UPDATE OR DELETE ON session_orphan_receipt
  FOR EACH ROW EXECUTE FUNCTION preserve_session_orphan_evidence();
CREATE TRIGGER session_orphan_disposition_immutable BEFORE UPDATE OR DELETE ON session_orphan_disposition
  FOR EACH ROW EXECUTE FUNCTION preserve_session_orphan_evidence();
--> statement-breakpoint
-- Install only after pg-boss owns both tables. Accepted task state updates remain legal.
CREATE FUNCTION fence_session_orphan_producer() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE current_phase text; not_before timestamptz;
BEGIN
  IF NEW.name IN ('prune_orphan_conversation_sessions','prune_orphan_placement_sessions') THEN
    SELECT phase, legacy_not_before INTO STRICT current_phase, not_before
      FROM session_orphan_control WHERE family = NEW.name FOR SHARE;
    IF current_phase <> 'pg-boss' OR not_before > clock_timestamp() THEN
      RAISE EXCEPTION 'session orphan pg-boss producer fenced: % %', NEW.name, current_phase;
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
