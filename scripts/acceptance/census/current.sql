-- Same R01 read-only census, parameterized by $1 = run start ISO time.
-- Run each statement in a READ ONLY transaction with statement_timeout=15s. Historical raw queries
-- (including schema-mismatch attempts) remain in audit-queries.sql; do not replay them.
SELECT name,state,count(*) n,min(created_on) oldest_created,max(retry_count) max_retry,
       max(completed_on) latest_completed FROM pgboss.job GROUP BY 1,2 ORDER BY 1,2;
SELECT name,retry_limit,dead_letter,retention_seconds,queued_count,active_count,failed_count,
       ready_oldest_seconds FROM pgboss.queue ORDER BY name;
SELECT name,cron,timezone,kind,last_job_id FROM pgboss.schedule ORDER BY name;
SELECT task_kind,status,count(*) n,sum(cost_usd) known_usd,
       count(*) FILTER (WHERE cost_usd IS NULL) unknown_cost
       FROM ai_task_runs GROUP BY 1,2 ORDER BY 1,2;
SELECT id,task_kind,provider,model,status,cost_usd,cost_basis,input_hash,result_digest,
       started_at,finished_at,error_message FROM ai_task_runs WHERE started_at >= $1 ORDER BY started_at;
SELECT attempt_id,attempt_kind,provider,model,operation_kind,terminal_status,wire_count,
       cost_basis,cost_amount,cost_currency,usage_json FROM provider_attempt WHERE started_at >= $1 ORDER BY started_at;
SELECT action,outcome,count(*) n FROM event GROUP BY 1,2 ORDER BY 1,2;
SELECT id,type,status,started_at,ended_at,updated_at FROM learning_session ORDER BY created_at DESC LIMIT 150;
SELECT id,status,warnings,error_message,created_at,updated_at FROM learning_session WHERE type='ingestion' ORDER BY created_at DESC LIMIT 150;
SELECT id,scope_key,evidence_count,refreshed_at,source_event_id FROM memory_brief_note ORDER BY scope_key;
SELECT approval_status,proposed_by_ai,count(*) n FROM knowledge GROUP BY 1,2 ORDER BY 1,2;
SELECT * FROM job_events WHERE business_table='copilot_run' ORDER BY id DESC LIMIT 150;
SELECT * FROM provider_session_admission LIMIT 150;
SELECT * FROM subagent_run LIMIT 150;
SELECT * FROM copilot_continuation LIMIT 150;
SELECT * FROM dag_orchestration_run LIMIT 150;
SELECT * FROM note_verification_claim LIMIT 150;
SELECT * FROM session_orphan_control LIMIT 150;
SELECT * FROM session_orphan_receipt LIMIT 150;
SELECT * FROM review_orphan_control LIMIT 150;
SELECT * FROM memory_reconciliation_log ORDER BY planned_at DESC LIMIT 150;
