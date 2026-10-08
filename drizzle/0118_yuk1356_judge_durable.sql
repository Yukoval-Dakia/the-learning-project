CREATE TABLE judge_run_control (
  id smallint PRIMARY KEY CONSTRAINT judge_run_control_singleton CHECK (id = 1),
  incarnation uuid NOT NULL,
  epoch bigint NOT NULL CONSTRAINT judge_run_control_epoch CHECK (epoch >= 0),
  phase text NOT NULL CONSTRAINT judge_run_control_phase CHECK (phase IN ('pg-boss','draining-pg-boss','dbos','draining-dbos')),
  phase_changed_at timestamptz NOT NULL,
  transition_event_id text
);
INSERT INTO judge_run_control VALUES (1, gen_random_uuid(), 0, 'pg-boss', clock_timestamp(), NULL);
--> statement-breakpoint
-- Reject pre-existing malformed operational receipts before the integer index casts.
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM event WHERE action IN
    ('experimental:judge_execution_binding','experimental:judge_delivery_reserved','experimental:judge_delivery_send')
    AND (payload->>'coordinate' IS DISTINCT FROM 'native' OR
      CASE action
        WHEN 'experimental:judge_execution_binding' THEN NOT coalesce(payload->>'attempt' ~ '^[1-9][0-9]{0,8}$', false)
        WHEN 'experimental:judge_delivery_reserved' THEN NOT coalesce(payload->>'slot' ~ '^[0-2]$', false)
        ELSE NOT coalesce(payload->>'send_no' ~ '^[1-9][0-9]{0,8}$', false)
      END)) THEN RAISE EXCEPTION 'Malformed pre-existing judge operational receipt'; END IF;
END $$;
CREATE UNIQUE INDEX judge_binding_key_uq ON event ((payload->>'evaluation_group_id'), (payload->>'execution_key')) WHERE action = 'experimental:judge_execution_binding';
CREATE UNIQUE INDEX judge_binding_attempt_uq ON event ((payload->>'submission_id'), ((payload->>'attempt')::bigint)) WHERE action = 'experimental:judge_execution_binding';
CREATE UNIQUE INDEX judge_reservation_slot_uq ON event ((payload->>'run_id'), ((payload->>'slot')::int)) WHERE action = 'experimental:judge_delivery_reserved';
CREATE UNIQUE INDEX judge_reservation_delivery_uq ON event ((payload->'ownership'->>'backend'), (payload->>'delivery_id')) WHERE action = 'experimental:judge_delivery_reserved';
CREATE UNIQUE INDEX judge_send_uq ON event ((payload->>'reservation_id'), ((payload->>'send_no')::bigint)) WHERE action = 'experimental:judge_delivery_send';
CREATE UNIQUE INDEX judge_rejection_uq ON event ((payload->>'send_id')) WHERE action = 'experimental:judge_delivery_rejected';
CREATE UNIQUE INDEX judge_acceptance_uq ON event ((payload->>'reservation_id')) WHERE action = 'experimental:judge_delivery_accepted';
CREATE UNIQUE INDEX judge_disposition_run_uq ON event ((payload->>'run_id')) WHERE action = 'experimental:judge_disposition' AND payload->>'coordinate' = 'native';
CREATE INDEX judge_operational_run_idx ON event ((payload->>'run_id'), action, created_at, id) WHERE action IN
  ('experimental:judge_execution_binding','experimental:judge_delivery_reserved','experimental:judge_delivery_send',
   'experimental:judge_delivery_rejected','experimental:judge_delivery_accepted','experimental:judge_delivery_started',
   'experimental:judge_disposition','experimental:judge_ownership');
CREATE INDEX judge_pending_scan_idx ON event (created_at, id) WHERE action = 'experimental:judge_pending_attempt';
--> statement-breakpoint
CREATE FUNCTION preserve_judge_operational_receipt() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.action IN ('experimental:judge_execution_binding','experimental:judge_delivery_reserved','experimental:judge_delivery_send',
    'experimental:judge_delivery_rejected','experimental:judge_delivery_accepted','experimental:judge_delivery_started',
    'experimental:judge_disposition','experimental:judge_ownership','experimental:judge_family_transition','experimental:judge_reconcile_observation') THEN
    RAISE EXCEPTION 'judge operational receipts are immutable';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER judge_operational_immutable BEFORE UPDATE OR DELETE ON event
  FOR EACH ROW EXECUTE FUNCTION preserve_judge_operational_receipt();
--> statement-breakpoint
-- Accepted deliveries retain state transitions. This fences new legacy tasks and cron registrations.
-- Installation takes the common producer installer lock in application code.
CREATE FUNCTION fence_judge_producer() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE current_phase text;
BEGIN
  IF NEW.name IN ('judge_run','judge_pending_reconcile') THEN
    SELECT phase INTO STRICT current_phase FROM judge_run_control WHERE id = 1 FOR SHARE;
    IF current_phase <> 'pg-boss' THEN
      RAISE EXCEPTION 'judge pg-boss producer fenced: %', current_phase;
    END IF;
  END IF;
  RETURN NEW;
END $$;
