
-- schema 2026-10-10T04:12:11.441739+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select table_schema,table_name,column_name,data_type from information_schema.columns where table_schema not in ('pg_catalog','information_schema') order by table_schema,table_name,ordinal_position;
COMMIT;

-- schema 2026-10-10T04:12:19.395777+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select table_schema,table_name,column_name,data_type from information_schema.columns where table_schema not in ('pg_catalog','information_schema') order by table_schema,table_name,ordinal_position;
COMMIT;

-- baseline-runs 2026-10-10T04:12:19.518596+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select id,task_kind,provider,model,status,cost_usd,cost_basis,cost_ref,usage_json,input_hash,result_digest,started_at,finished_at,error_message from ai_task_runs where started_at >= '2026-10-10T04:12:11.440031+00:00' order by started_at;
COMMIT;

-- baseline-attempts 2026-10-10T04:12:19.575621+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select attempt_id,attempt_kind,provider,model,operation_kind,terminal_status,wire_count,cost_basis,cost_amount,cost_currency,usage_json,started_at,finished_at from provider_attempt where started_at >= '2026-10-10T04:12:11.440031+00:00' order by started_at;
COMMIT;

-- baseline-iterations 2026-10-10T04:12:19.628001+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select task_run_id,max(iteration)+1 n from tool_call_log where occurred_at >= '2026-10-10T04:12:11.440031+00:00' and tool_name like 'mcp__%' group by 1;
COMMIT;

-- queue-states 2026-10-10T04:13:39.519045+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select name,state,count(*) n,min(created_on) oldest_created,max(retry_count) max_retry,min(start_after) oldest_start_after,max(completed_on) latest_completed from pgboss.job group by 1,2 order by 1,2;
COMMIT;

-- failed-dlq 2026-10-10T04:13:40.003845+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select id,name,state,retry_count,retry_limit,created_on,started_on,completed_on,keep_until,left(output::text,1800) output,source_id,source_name from pgboss.job where state='failed' or name like '%_dlq' order by created_on limit 300;
COMMIT;

-- queue-policy 2026-10-10T04:13:40.154484+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select name,retry_limit,dead_letter,retention_seconds,queued_count,active_count,failed_count,ready_oldest_seconds from pgboss.queue order by name;
COMMIT;

-- schedules 2026-10-10T04:13:40.225270+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select name,cron,timezone,kind,last_job_id,created_on,updated_on from pgboss.schedule order by name;
COMMIT;

-- run-census 2026-10-10T04:13:40.288400+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select task_kind,status,count(*) n,sum(cost_usd) usd,count(*) filter(where cost_usd is null) unknown_cost,min(started_at) oldest,max(finished_at) latest from ai_task_runs group by 1,2 order by 1,2;
COMMIT;

-- run-failures 2026-10-10T04:13:40.338898+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select id,task_kind,status,error_message,started_at,finished_at from ai_task_runs where status <> 'success' order by started_at desc limit 200;
COMMIT;

-- events-census 2026-10-10T04:13:40.395949+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select action,outcome,count(*) n,min(created_at) oldest,max(created_at) latest from event group by 1,2 order by 1,2;
COMMIT;

-- coach-outcomes 2026-10-10T04:13:40.451002+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select id,action,outcome,payload,task_run_id,created_at from event where action in ('coach_scan','coach_daily') order by created_at desc limit 100;
COMMIT;

-- artifact-status 2026-10-10T04:13:40.514798+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select type,generation_status,verification_status,count(*) n,min(created_at) oldest from artifact where archived_at is null group by 1,2,3 order by 1,2,3;
COMMIT;

-- artifact-provenance 2026-10-10T04:13:40.565920+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select id,type,title,generation_status,verification_status,source_ref,generated_by,attrs,created_at,updated_at from artifact order by created_at desc limit 100;
COMMIT;

-- checkpoint 2026-10-10T04:13:40.616993+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select c.*, (select max(dispatch_seq) from event) max_event_seq from event_subscription_checkpoint c order by subscriber_id;
COMMIT;

-- deliveries 2026-10-10T04:13:40.668428+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select subscriber_id,status,count(*) n,min(discovered_at) oldest,max(attempt_count) max_attempts,max(redrive_count) max_redrive from event_subscription_delivery group by 1,2 order by 1,2;
COMMIT;

-- delivery-errors 2026-10-10T04:13:40.721987+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select subscriber_id,source_event_id,status,attempt_count,last_error,next_attempt_at,discovered_at,completed_at from event_subscription_delivery where status not in ('completed','skipped') order by discovered_at limit 100;
COMMIT;

-- effects 2026-10-10T04:13:40.774558+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select subscriber_id,effect_kind,status,count(*) n,min(reserved_at) oldest from event_subscription_effect group by 1,2,3 order by 1,2,3;
COMMIT;

-- question-lifecycle 2026-10-10T04:13:40.822411+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select availability,scoring_admission_state,scoring_admission_withheld_reason,count(*) n from question_group_lifecycle group by 1,2,3;
COMMIT;

-- sessions 2026-10-10T04:13:40.869683+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select id,type,status,entrypoint,error_message,summary_md,placement_pace,started_at,ended_at,updated_at from learning_session order by created_at desc limit 150;
COMMIT;

-- learning-item-due 2026-10-10T04:13:40.916551+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select status,count(*) n,count(due_at) due_nonnull,min(due_at) oldest_due from learning_item group by status;
COMMIT;

-- pace 2026-10-10T04:13:40.961750+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select type,status,placement_pace,count(*) n,min(started_at) oldest,max(started_at) latest from learning_session group by 1,2,3;
COMMIT;

-- calibration-delta 2026-10-10T04:13:41.012374+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select count(*) n,count(b_calib) calibrated,count(*) filter(where abs(b_calib-b_anchor)>0.5) delta_gt_half,count(*) filter(where abs(b_calib-b_anchor)>1) delta_gt_one,avg(b_calib-b_anchor) avg_delta,max(abs(b_calib-b_anchor)) max_delta from item_calibration;
COMMIT;

-- calibration-labels 2026-10-10T04:13:41.059361+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select question_id,count(*) n,min(created_at) oldest,max(created_at) latest,avg(b_label) avg_label from difficulty_calibration_label group by 1;
COMMIT;

-- pi-coverage 2026-10-10T04:13:41.105269+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select s.source,s.added_by,count(*) n,count(o.id) with_observation,count(*) filter(where o.id is null) missing from practice_stream_item s left join selection_observation o on o.stream_item_id=s.id group by 1,2 order by 1,2;
COMMIT;

-- pi-raw 2026-10-10T04:13:41.156104+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select * from selection_observation order by created_at limit 100;
COMMIT;

-- mastery 2026-10-10T04:13:41.213315+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select m.*,k.name,f.state fsrs_state,f.due_at from mastery_state m left join knowledge k on m.subject_kind='knowledge' and k.id=m.subject_id left join material_fsrs_state f on f.subject_kind=m.subject_kind and f.subject_id=m.subject_id order by m.subject_id;
COMMIT;

-- interventions 2026-10-10T04:13:41.266892+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select id,status,delivery_mode,outcome,failure_code,settlement_json,created_at,updated_at from intervention order by created_at limit 100;
COMMIT;

-- approval-burden 2026-10-10T04:13:41.358916+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select date_trunc('week',created_at) week,action,payload->>'kind' kind,count(*) n from event where action like '%propos%' or action in ('rate','experimental:completion_autoapply','accept_suggestion') group by 1,2,3 order by 1,2,3;
COMMIT;

-- corrections 2026-10-10T04:13:41.423493+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select id,action,subject_kind,subject_id,payload,created_at from event where action like '%retract%' or action like '%correct%' or action like '%regrade%' order by created_at limit 100;
COMMIT;

-- memory-links 2026-10-10T04:13:41.477512+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select id,scope_key,evidence_count,source_event_id,latest_evidence_at,refreshed_at,recent_week_evidence_ids,recent_months_evidence_ids,long_term_evidence_ids from memory_brief_note order by refreshed_at;
COMMIT;

-- constraints 2026-10-10T04:13:41.575055+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select c.conname,c.contype,pg_get_constraintdef(c.oid) definition from pg_constraint c join pg_class t on t.oid=c.conrelid where t.relname in ('knowledge','assessment_submission','event','learning_item') order by t.relname,c.conname;
COMMIT;

-- block-status 2026-10-10T04:13:41.650693+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select status,count(*) n,count(imported_question_id) imported,count(*) filter(where coalesce(extracted_prompt_md,'')='') empty_prompt,min(created_at) oldest from question_block group by status;
COMMIT;

-- question-publication 2026-10-10T04:13:41.714242+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select draft_status,source,count(*) n from question group by 1,2;
COMMIT;

-- editing_presence 2026-10-10T04:13:41.763131+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select * from editing_presence limit 150;
COMMIT;

-- placement_starter_claim 2026-10-10T04:13:41.812204+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select * from placement_starter_claim limit 150;
COMMIT;

-- placement_starter_attempt 2026-10-10T04:13:41.862128+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select * from placement_starter_attempt limit 150;
COMMIT;

-- provider_session_admission 2026-10-10T04:13:41.912422+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select * from provider_session_admission limit 150;
COMMIT;

-- subagent_run 2026-10-10T04:13:41.967407+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select * from subagent_run limit 150;
COMMIT;

-- copilot_continuation 2026-10-10T04:13:42.025600+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select * from copilot_continuation limit 150;
COMMIT;

-- dag_orchestration_run 2026-10-10T04:13:42.081826+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select * from dag_orchestration_run limit 150;
COMMIT;

-- note_verification_claim 2026-10-10T04:13:42.138875+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select * from note_verification_claim limit 150;
COMMIT;

-- session_orphan_control 2026-10-10T04:13:42.191528+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select * from session_orphan_control limit 150;
COMMIT;

-- session_orphan_receipt 2026-10-10T04:13:42.247174+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select * from session_orphan_receipt limit 150;
COMMIT;

-- review_orphan_control 2026-10-10T04:13:42.293311+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select * from review_orphan_control limit 150;
COMMIT;

-- hub_sync_reconciliation 2026-10-10T04:13:42.340861+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select * from hub_sync_reconciliation limit 150;
COMMIT;

-- edge_reconciliation_log 2026-10-10T04:13:42.388061+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select * from edge_reconciliation_log limit 150;
COMMIT;

-- tool_operation 2026-10-10T04:13:42.440259+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select * from tool_operation limit 150;
COMMIT;

-- contract_epoch 2026-10-10T04:13:42.495012+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select * from contract_epoch limit 150;
COMMIT;

-- learning_project_memories 2026-10-10T04:13:42.545959+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select * from learning_project_memories limit 150;
COMMIT;

-- memory_reconciliation_log 2026-10-10T04:13:42.619608+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select * from memory_reconciliation_log limit 150;
COMMIT;

-- provider_attempt_admission 2026-10-10T04:13:42.675050+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select * from provider_attempt_admission limit 150;
COMMIT;

-- flags-db 2026-10-10T04:13:42.731396+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select key,value,revision,source_note from system_config where key ~* '(ENABLED|THETA|SRT|INTERVENTION|CONTRAST|SAMPLING|RECURRENCE|refill|dream|pace)' order by key;
COMMIT;

-- pending-proposals 2026-10-10T04:14:20.169393+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select id,action,subject_kind,subject_id,payload,created_at from event where action='propose' and not exists(select 1 from event r where r.action='rate' and r.subject_id=event.id) order by created_at;
COMMIT;

-- job-note-links 2026-10-10T04:14:20.545573+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select id,name,state,data,output,created_on,started_on,completed_on from pgboss.job where name in ('note_generate','coach_daily','memory_brief_refresh','dreaming_nightly') order by created_on desc limit 40;
COMMIT;

-- accept-race-events 2026-10-10T04:14:57.446826+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select id,action,outcome,payload,created_at from event where subject_id='wj81jsiz4vk7l2smms68zxib' or caused_by_event_id='wj81jsiz4vk7l2smms68zxib' order by created_at;
COMMIT;

-- accept-race-knowledge 2026-10-10T04:14:57.626247+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select id,name,parent_id,domain,created_at from knowledge where created_at>='2026-10-10T04:14:57.210834+00:00';
COMMIT;

-- accept-race-artifacts 2026-10-10T04:14:57.677314+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select id,type,title,generation_status,created_at from artifact where created_at>='2026-10-10T04:14:57.210834+00:00';
COMMIT;

-- after-accept-runs 2026-10-10T04:14:57.786441+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select id,task_kind,provider,model,status,cost_usd,cost_basis,cost_ref,usage_json,input_hash,result_digest,started_at,finished_at,error_message from ai_task_runs where started_at >= '2026-10-10T04:12:11.440031+00:00' order by started_at;
COMMIT;

-- after-accept-attempts 2026-10-10T04:14:57.858133+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select attempt_id,attempt_kind,provider,model,operation_kind,terminal_status,wire_count,cost_basis,cost_amount,cost_currency,usage_json,started_at,finished_at from provider_attempt where started_at >= '2026-10-10T04:12:11.440031+00:00' order by started_at;
COMMIT;

-- after-accept-iterations 2026-10-10T04:14:57.907836+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select task_run_id,max(iteration)+1 n from tool_call_log where occurred_at >= '2026-10-10T04:12:11.440031+00:00' and tool_name like 'mcp__%' group by 1;
COMMIT;

-- notes-running-runs 2026-10-10T04:15:14.374367+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select id,task_kind,provider,model,status,cost_usd,cost_basis,cost_ref,usage_json,input_hash,result_digest,started_at,finished_at,error_message from ai_task_runs where started_at >= '2026-10-10T04:12:11.440031+00:00' order by started_at;
COMMIT;

-- notes-running-attempts 2026-10-10T04:15:14.454333+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select attempt_id,attempt_kind,provider,model,operation_kind,terminal_status,wire_count,cost_basis,cost_amount,cost_currency,usage_json,started_at,finished_at from provider_attempt where started_at >= '2026-10-10T04:12:11.440031+00:00' order by started_at;
COMMIT;

-- notes-running-iterations 2026-10-10T04:15:14.506458+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select task_run_id,max(iteration)+1 n from tool_call_log where occurred_at >= '2026-10-10T04:12:11.440031+00:00' and tool_name like 'mcp__%' group by 1;
COMMIT;

-- notes-progress 2026-10-10T04:15:33.102163+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select id,type,title,generation_status,verification_status,attrs from artifact where created_at>='2026-10-10T04:14:57Z';
COMMIT;

-- notes-jobs-progress 2026-10-10T04:15:33.567381+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select id,name,state,data,retry_count,created_on,started_on,completed_on,output from pgboss.job where created_on>='2026-10-10T04:14:57Z' and name='note_generate';
COMMIT;

-- notes-check-runs 2026-10-10T04:15:33.683959+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select id,task_kind,provider,model,status,cost_usd,cost_basis,cost_ref,usage_json,input_hash,result_digest,started_at,finished_at,error_message from ai_task_runs where started_at >= '2026-10-10T04:12:11.440031+00:00' order by started_at;
COMMIT;

-- notes-check-attempts 2026-10-10T04:15:33.770671+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select attempt_id,attempt_kind,provider,model,operation_kind,terminal_status,wire_count,cost_basis,cost_amount,cost_currency,usage_json,started_at,finished_at from provider_attempt where started_at >= '2026-10-10T04:12:11.440031+00:00' order by started_at;
COMMIT;

-- notes-check-iterations 2026-10-10T04:15:33.852049+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select task_run_id,max(iteration)+1 n from tool_call_log where occurred_at >= '2026-10-10T04:12:11.440031+00:00' and tool_name like 'mcp__%' group by 1;
COMMIT;

-- notes-check2-runs 2026-10-10T04:16:27.810622+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select id,task_kind,provider,model,status,cost_usd,cost_basis,cost_ref,usage_json,input_hash,result_digest,started_at,finished_at,error_message from ai_task_runs where started_at >= '2026-10-10T04:12:11.440031+00:00' order by started_at;
COMMIT;

-- notes-check2-attempts 2026-10-10T04:16:28.432815+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select attempt_id,attempt_kind,provider,model,operation_kind,terminal_status,wire_count,cost_basis,cost_amount,cost_currency,usage_json,started_at,finished_at from provider_attempt where started_at >= '2026-10-10T04:12:11.440031+00:00' order by started_at;
COMMIT;

-- notes-check2-iterations 2026-10-10T04:16:28.554998+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select task_run_id,max(iteration)+1 n from tool_call_log where occurred_at >= '2026-10-10T04:12:11.440031+00:00' and tool_name like 'mcp__%' group by 1;
COMMIT;

-- jobs-now 2026-10-10T04:17:17.578452+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select id,name,state,retry_count,data,created_on,completed_on from pgboss.job where created_on>='2026-10-10T04:14:57Z';
COMMIT;

-- check3-runs 2026-10-10T04:17:18.742674+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select id,task_kind,provider,model,status,cost_usd,cost_basis,cost_ref,usage_json,input_hash,result_digest,started_at,finished_at,error_message from ai_task_runs where started_at >= '2026-10-10T04:12:11.440031+00:00' order by started_at;
COMMIT;

-- check3-attempts 2026-10-10T04:17:19.095472+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select attempt_id,attempt_kind,provider,model,operation_kind,terminal_status,wire_count,cost_basis,cost_amount,cost_currency,usage_json,started_at,finished_at from provider_attempt where started_at >= '2026-10-10T04:12:11.440031+00:00' order by started_at;
COMMIT;

-- check3-iterations 2026-10-10T04:17:19.587081+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select task_run_id,max(iteration)+1 n from tool_call_log where occurred_at >= '2026-10-10T04:12:11.440031+00:00' and tool_name like 'mcp__%' group by 1;
COMMIT;

-- cp-refresh-runs 2026-10-10T04:18:56.304235+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select id,task_kind,provider,model,status,cost_usd,cost_basis,cost_ref,usage_json,input_hash,result_digest,started_at,finished_at,error_message from ai_task_runs where started_at >= '2026-10-10T04:12:11.440031+00:00' order by started_at;
COMMIT;

-- cp-refresh-attempts 2026-10-10T04:18:56.595915+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select attempt_id,attempt_kind,provider,model,operation_kind,terminal_status,wire_count,cost_basis,cost_amount,cost_currency,usage_json,started_at,finished_at from provider_attempt where started_at >= '2026-10-10T04:12:11.440031+00:00' order by started_at;
COMMIT;

-- cp-refresh-iterations 2026-10-10T04:18:56.657388+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select task_run_id,max(iteration)+1 n from tool_call_log where occurred_at >= '2026-10-10T04:12:11.440031+00:00' and tool_name like 'mcp__%' group by 1;
COMMIT;

-- after-cp-cancel-runs 2026-10-10T04:19:32.551947+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select id,task_kind,provider,model,status,cost_usd,cost_basis,cost_ref,usage_json,input_hash,result_digest,started_at,finished_at,error_message from ai_task_runs where started_at >= '2026-10-10T04:12:11.440031+00:00' order by started_at;
COMMIT;

-- after-cp-cancel-attempts 2026-10-10T04:19:32.850822+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select attempt_id,attempt_kind,provider,model,operation_kind,terminal_status,wire_count,cost_basis,cost_amount,cost_currency,usage_json,started_at,finished_at from provider_attempt where started_at >= '2026-10-10T04:12:11.440031+00:00' order by started_at;
COMMIT;

-- after-cp-cancel-iterations 2026-10-10T04:19:32.925742+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select task_run_id,max(iteration)+1 n from tool_call_log where occurred_at >= '2026-10-10T04:12:11.440031+00:00' and tool_name like 'mcp__%' group by 1;
COMMIT;

-- notes-jobs-check4 2026-10-10T04:19:43.371218+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select id,name,state,retry_count,data,created_on,started_on,completed_on from pgboss.job where name='note_generate' and created_on>='2026-10-10T04:14:57Z';
COMMIT;

-- before-hint-runs 2026-10-10T04:19:43.610683+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select id,task_kind,provider,model,status,cost_usd,cost_basis,cost_ref,usage_json,input_hash,result_digest,started_at,finished_at,error_message from ai_task_runs where started_at >= '2026-10-10T04:12:11.440031+00:00' order by started_at;
COMMIT;

-- before-hint-attempts 2026-10-10T04:19:43.695535+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select attempt_id,attempt_kind,provider,model,operation_kind,terminal_status,wire_count,cost_basis,cost_amount,cost_currency,usage_json,started_at,finished_at from provider_attempt where started_at >= '2026-10-10T04:12:11.440031+00:00' order by started_at;
COMMIT;

-- before-hint-iterations 2026-10-10T04:19:43.755398+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select task_run_id,max(iteration)+1 n from tool_call_log where occurred_at >= '2026-10-10T04:12:11.440031+00:00' and tool_name like 'mcp__%' group by 1;
COMMIT;

-- copilot-operations 2026-10-10T04:20:02.255018+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select * from tool_operation where id like 'copilot%' order by created_at desc limit 10;
COMMIT;

-- note-trace 2026-10-10T04:20:23.094096+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select id,generated_by,generation_status,history,attrs from artifact where id='e2lx3ramgjry5gy5eqqcyuta';
COMMIT;

-- hint-pre-runs 2026-10-10T04:20:23.368790+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select id,task_kind,provider,model,status,cost_usd,cost_basis,cost_ref,usage_json,input_hash,result_digest,started_at,finished_at,error_message from ai_task_runs where started_at >= '2026-10-10T04:12:11.440031+00:00' order by started_at;
COMMIT;

-- hint-pre-attempts 2026-10-10T04:20:23.426731+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select attempt_id,attempt_kind,provider,model,operation_kind,terminal_status,wire_count,cost_basis,cost_amount,cost_currency,usage_json,started_at,finished_at from provider_attempt where started_at >= '2026-10-10T04:12:11.440031+00:00' order by started_at;
COMMIT;

-- hint-pre-iterations 2026-10-10T04:20:23.480537+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select task_run_id,max(iteration)+1 n from tool_call_log where occurred_at >= '2026-10-10T04:12:11.440031+00:00' and tool_name like 'mcp__%' group by 1;
COMMIT;

-- mid-runs 2026-10-10T04:23:58.754492+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select id,task_kind,provider,model,status,cost_usd,cost_basis,cost_ref,usage_json,input_hash,result_digest,started_at,finished_at,error_message from ai_task_runs where started_at >= '2026-10-10T04:12:11.440031+00:00' order by started_at;
COMMIT;

-- mid-attempts 2026-10-10T04:23:59.135520+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select attempt_id,attempt_kind,provider,model,operation_kind,terminal_status,wire_count,cost_basis,cost_amount,cost_currency,usage_json,started_at,finished_at from provider_attempt where started_at >= '2026-10-10T04:12:11.440031+00:00' order by started_at;
COMMIT;

-- mid-iterations 2026-10-10T04:23:59.203036+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select task_run_id,max(iteration)+1 n from tool_call_log where occurred_at >= '2026-10-10T04:12:11.440031+00:00' and tool_name like 'mcp__%' group by 1;
COMMIT;

-- artifacts-mid 2026-10-10T04:23:59.263739+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select generation_status,count(*) from artifacts where created_at >='2026-10-10T04:12:11.440031+00:00' group by 1;
COMMIT;

-- artifacts-mid 2026-10-10T04:24:36.294816+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select id,type,generation_status,verification_status,title from artifact where created_at>='2026-10-10T04:12:11.440031+00:00' order by id;
COMMIT;

-- starter-claims-start 2026-10-10T04:25:01.441276+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select * from placement_starter_claim;
COMMIT;

-- notes-jobs-live 2026-10-10T04:26:05.319181+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select id,name,state,data,retry_count,retry_limit,start_after,started_on,completed_on,left(output::text,900) output from pgboss.job where created_on>='2026-10-10T04:12:11.440031+00:00' and name like 'note%' order by created_on;
COMMIT;

-- starter-live 2026-10-10T04:26:05.610043+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select * from placement_starter_attempt;
COMMIT;

-- hint-events 2026-10-10T04:26:05.681772+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select id,action,subject_id,payload,created_at from event where session_id='ddosy23l2ss9b7oh8ihw1bbw' order by created_at;
COMMIT;

-- m25-runs 2026-10-10T04:26:05.740401+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select id,task_kind,provider,model,status,cost_usd,cost_basis,cost_ref,usage_json,input_hash,result_digest,started_at,finished_at,error_message from ai_task_runs where started_at >= '2026-10-10T04:12:11.440031+00:00' order by started_at;
COMMIT;

-- m25-attempts 2026-10-10T04:26:05.789430+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select attempt_id,attempt_kind,provider,model,operation_kind,terminal_status,wire_count,cost_basis,cost_amount,cost_currency,usage_json,started_at,finished_at from provider_attempt where started_at >= '2026-10-10T04:12:11.440031+00:00' order by started_at;
COMMIT;

-- m25-iterations 2026-10-10T04:26:05.841167+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select task_run_id,max(iteration)+1 n from tool_call_log where occurred_at >= '2026-10-10T04:12:11.440031+00:00' and tool_name like 'mcp__%' group by 1;
COMMIT;

-- checkpoint-aligned 2026-10-10T04:26:52.440670+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select c.subscriber_id,c.status,c.next_delivery_seq,max(d.delivery_seq) max_delivery_seq,count(d.*) filter(where d.delivery_seq>=c.next_delivery_seq and d.status not in ('completed','skipped')) pending_at_or_after_cursor,min(d.discovered_at) filter(where d.status not in ('completed','skipped')) oldest_unfinished from event_subscription_checkpoint c left join event_subscription_delivery d using(subscriber_id) group by c.subscriber_id,c.status,c.next_delivery_seq;
COMMIT;

-- ingestion-final 2026-10-10T04:26:52.782145+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select id,type,status,entrypoint,error_message,started_at,ended_at,updated_at from learning_session where id in ('kudmr2zkg0kmy0h4a6i8cl39','ligvf35icyalsybzpqfwq5pz','w2628yerss6gylsm37n4i13n');
COMMIT;

-- blocks-r01 2026-10-10T04:26:52.856423+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select id,ingestion_session_id,status,imported_question_id,imported_attempt_event_id,extracted_prompt_md,wrong_answer_md,knowledge_hint,structured,created_at,updated_at from question_block where ingestion_session_id in ('kudmr2zkg0kmy0h4a6i8cl39','ligvf35icyalsybzpqfwq5pz','w2628yerss6gylsm37n4i13n');
COMMIT;

-- ingestion-events-r01 2026-10-10T04:26:52.918481+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select * from job_events where business_id in ('kudmr2zkg0kmy0h4a6i8cl39','ligvf35icyalsybzpqfwq5pz','w2628yerss6gylsm37n4i13n') order by occurred_at;
COMMIT;

-- coach-outcomes-corrected 2026-10-10T04:26:52.980087+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select id,action,outcome,payload,task_run_id,created_at from event where action like '%coach_scan%' or action like '%coach_daily%' order by created_at desc limit 100;
COMMIT;

-- failed-dlq-totals 2026-10-10T04:26:53.040147+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select name,state,count(*) n,min(created_on) oldest,min(extract(epoch from(now()-created_on))) youngest_age_s,max(extract(epoch from(now()-created_on))) oldest_age_s,count(*) filter(where retry_count>=retry_limit) retries_exhausted from pgboss.job where state='failed' or name like '%_dlq' group by name,state order by name,state;
COMMIT;

-- note-job-run-join 2026-10-10T04:26:53.107772+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select j.id job_id,j.state,j.data->>'artifact_id' artifact_id,j.retry_count,j.retry_limit,j.created_on,j.started_on,j.completed_on,a.generation_status,a.verification_status,r.id task_run_id,r.status task_status,r.started_at,r.finished_at,r.cost_usd from pgboss.job j left join artifact a on a.id=j.data->>'artifact_id' left join ai_task_runs r on r.task_kind='NoteGenerateTask' and r.started_at>=j.started_on and r.started_at<=coalesce(j.completed_on,now()) where j.name='note_generate' and j.created_on>='2026-10-10T04:12:11.440031+00:00' order by j.created_on,r.started_at;
COMMIT;

-- memory-lineage 2026-10-10T04:26:53.165852+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select id,payload->'metadata' metadata,md5(payload::text) payload_digest from learning_project_memories order by id;
COMMIT;

-- asset-reference-census 2026-10-10T04:26:53.219444+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select a.id,a.kind,a.created_at,(select count(*) from source_document d where d.source_asset_ids ? a.id) documents,(select count(*) from question_block b where b.source_asset_ids ? a.id or b.image_refs::text like '%'||a.id||'%' or b.crop_refs::text like '%'||a.id||'%') blocks,(select count(*) from question q where q.images::text like '%'||a.id||'%') questions from source_asset a order by a.created_at;
COMMIT;

-- knowledge-roots 2026-10-10T04:26:53.278221+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select k.id,k.name,k.parent_id,k.effective_domain,k.domain,k.attributes,k.archived_at,k.created_at from knowledge k where k.created_at>='2026-10-10T04:12:11.440031+00:00' order by k.created_at;
COMMIT;

-- parent-cycles 2026-10-10T04:26:53.325429+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
with recursive p as(select id,parent_id,array[id] path,false cycle from knowledge where archived_at is null union all select p.id,k.parent_id,p.path||k.id,k.id=any(p.path) from p join knowledge k on p.parent_id=k.id where not p.cycle and cardinality(p.path)<50) select id,path,cycle from p where cycle;
COMMIT;

-- rt-observed 2026-10-10T04:26:53.375410+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select id,subject_id,payload->'rt_ms' rt_ms,payload->'hints_used' hints_used,payload->'assisted' assisted,created_at from event where action in ('review','judge') or action like '%hint%' order by created_at;
COMMIT;

-- calibration-current 2026-10-10T04:26:53.431995+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select * from item_calibration order by question_id;
COMMIT;

-- all-obligation-counts 2026-10-10T04:26:53.484078+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select 'tool_operation' kind,status,count(*) n from tool_operation group by status union all select 'provider_attempt_admission',status,count(*) from provider_attempt_admission group by status union all select 'subagent_run',status,count(*) from subagent_run group by status union all select 'copilot_continuation',status,count(*) from copilot_continuation group by status union all select 'placement_starter_claim',status,count(*) from placement_starter_claim group by status;
COMMIT;

-- help-exposures 2026-10-10T04:26:53.543416+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select * from assessment_help_exposure limit 100;
COMMIT;

-- race-admitted 2026-10-10T04:27:31.788202+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select group_id from question_group_lifecycle where scoring_admission_state='admitted' order by group_id limit 1;
COMMIT;

-- race-submissions-final 2026-10-10T04:27:32.103532+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select * from assessment_submission where evaluation_group_id='R01_race_group';
COMMIT;

-- race-draft-final 2026-10-10T04:27:32.160675+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select * from assessment_response_draft where issuance_id='iss_cjruwx00z7ku4vjoeeomw0b1';
COMMIT;

-- asset-reference-census 2026-10-10T04:28:19.350378+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select a.id,a.kind,a.created_at,(select count(*) from source_document d where d.source_asset_ids ? a.id) documents,(select count(*) from question_block b where b.source_asset_ids ? a.id or b.image_refs::text like '%'||a.id||'%' or b.crop_refs::text like '%'||a.id||'%') blocks,(select count(*) from question q where q.image_refs::text like '%'||a.id||'%') questions from source_asset a order by a.created_at;
COMMIT;

-- knowledge-roots 2026-10-10T04:28:19.659932+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select id,name,parent_id,domain,archived_at,created_at from knowledge where created_at>='2026-10-10T04:12:11.440031+00:00' order by created_at;
COMMIT;

-- memory-retraction-joins 2026-10-10T04:28:19.727038+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select m.id,m.payload->'metadata' metadata,e.id event_id,e.action,e.created_at from learning_project_memories m join event e on m.payload::text like '%'||e.id||'%' where e.action like '%retract%' or e.action like '%correct%' or e.action like '%regrade%';
COMMIT;

-- background-jobs 2026-10-10T04:28:19.791097+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select id,name,state,retry_count,retry_limit,created_on,started_on,completed_on,left(output::text,1700) output from pgboss.job where name ~ '(coach|memory|dream|maintenance|agent_analysis|confusable|kt_estimate)' order by created_on desc limit 200;
COMMIT;

-- help-events-current 2026-10-10T04:28:19.878205+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select id,action,subject_id,payload,created_at from event where action like '%help%' or action like '%hint%' order by created_at;
COMMIT;

-- config-safe-flags 2026-10-10T04:28:19.928267+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select key,value,revision from system_config where key not like '%budget%' and key ~* '(enabled|theta|srt|sampling|recurrence|contrast)' order by key;
COMMIT;

-- m30-runs 2026-10-10T04:28:20.114674+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select id,task_kind,provider,model,status,cost_usd,cost_basis,cost_ref,usage_json,input_hash,result_digest,started_at,finished_at,error_message from ai_task_runs where started_at >= '2026-10-10T04:12:11.440031+00:00' order by started_at;
COMMIT;

-- m30-attempts 2026-10-10T04:28:20.171717+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select attempt_id,attempt_kind,provider,model,operation_kind,terminal_status,wire_count,cost_basis,cost_amount,cost_currency,usage_json,started_at,finished_at from provider_attempt where started_at >= '2026-10-10T04:12:11.440031+00:00' order by started_at;
COMMIT;

-- m30-iterations 2026-10-10T04:28:20.226188+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select task_run_id,max(iteration)+1 n from tool_call_log where occurred_at >= '2026-10-10T04:12:11.440031+00:00' and tool_name like 'mcp__%' group by 1;
COMMIT;

-- notes-state-28 2026-10-10T04:28:33.401724+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select state,count(*) n,max(retry_count) retry,max(extract(epoch from(now()-created_on))) age_s from pgboss.job where name='note_generate' and created_on>='2026-10-10T04:12:11.440031+00:00' group by state;
COMMIT;

-- starter-28 2026-10-10T04:28:33.692628+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select id,status,known_cost_micro_usd,next_reconcile_at,last_error_class,last_error_code,last_error from placement_starter_claim;
COMMIT;

-- starter-attempt-28 2026-10-10T04:28:33.758073+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select id,status,error_class,error_code,error_message,started_at,finished_at from placement_starter_attempt;
COMMIT;

-- latest-runs 2026-10-10T04:28:59.059952+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select id,task_kind,status,cost_usd,started_at,finished_at,left(error_message,120) err from ai_task_runs where started_at>='2026-10-10T04:12:11.440031+00:00' order by started_at desc limit 12;
COMMIT;

-- starter-costs 2026-10-10T04:28:59.339557+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select * from placement_starter_cost_component;
COMMIT;

-- active-task-budgets 2026-10-10T04:29:51.786147+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select key,value,revision from system_config where key in ('task.NoteGenerateTask.budget','task.QuizGenTask.budget','task.MemoryBriefTask.budget','task.TeachingTurnTask.budget','task.CopilotTask.budget');
COMMIT;

-- wire-meter 2026-10-10T04:29:52.055446+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select operation_kind,terminal_status,sum(wire_count) wires,count(*) attempts,cost_basis,cost_currency,sum(cost_amount) amount from provider_attempt where started_at>='2026-10-10T04:12:11.440031+00:00' group by 1,2,5,6;
COMMIT;

-- all-iterations 2026-10-10T04:29:52.118881+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select task_run_id,min(iteration) lo,max(iteration) hi,count(*) n from tool_call_log where occurred_at>='2026-10-10T04:12:11.440031+00:00' group by task_run_id;
COMMIT;

-- native-latest 2026-10-10T04:30:33.632569+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select id,action,subject_id,outcome,payload from event where action like '%settle%' or action like '%assessment%' order by created_at desc limit 12;
COMMIT;

-- admitted-kinds 2026-10-10T04:31:00.477266+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select q.id,q.kind,q.source,q.draft_status,l.availability,l.scoring_admission_state from question q join question_group_lifecycle l on l.group_id=q.id where l.scoring_admission_state='admitted';
COMMIT;

-- evaluation-count 2026-10-10T04:31:00.764731+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select count(*) n from evaluation;
COMMIT;

-- assessment-events-count 2026-10-10T04:31:00.828648+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select action,outcome,count(*) n from event where action like '%completion%' or action like '%assessment%' group by action,outcome order by action;
COMMIT;

-- mcq-frozen 2026-10-10T04:31:31.383600+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select * from question_revision where group_id='i2ytzyvs4h8uy1f9hcvp09r9' order by created_at desc limit 1;
COMMIT;

-- mcq-frozen-corrected 2026-10-10T04:31:38.059067+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select group_id,execution_plan,scoring_basis,response_spec from question_revision where group_id='i2ytzyvs4h8uy1f9hcvp09r9' order by published_at desc limit 1;
COMMIT;

-- admitted-executors 2026-10-10T04:31:46.250032+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select l.group_id,r.execution_plan from question_group_lifecycle l join question_revision r on r.revision_id=l.current_revision_id where l.scoring_admission_state='admitted';
COMMIT;

-- wrong-series-before 2026-10-10T04:32:07.422377+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select * from mastery_state where subject_id in (select jsonb_array_elements_text(knowledge_ids) from question where id='v1zkg2mrb3no3qc9ziv4fhov');
COMMIT;

-- wrong-series-evaluations 2026-10-10T04:32:07.767234+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select * from evaluation where evaluation_group_id like 'solve_%' order by created_at desc limit 12;
COMMIT;

-- wrong-series-events 2026-10-10T04:32:07.829244+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select * from event where created_at>='2026-10-10T04:32:07.761032+00:00' and (action like '%assessment%' or action like '%nudge%' or action like '%failure%') order by created_at;
COMMIT;

-- wrong-series-after 2026-10-10T04:32:07.889183+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select * from mastery_state where subject_id in (select jsonb_array_elements_text(knowledge_ids) from question where id='v1zkg2mrb3no3qc9ziv4fhov');
COMMIT;

-- wrong-series-before 2026-10-10T04:32:22.373947+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select * from mastery_state where subject_id in (select jsonb_array_elements_text(knowledge_ids) from question where id='v1zkg2mrb3no3qc9ziv4fhov');
COMMIT;

-- wrong-series-evaluations 2026-10-10T04:32:23.025838+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select * from evaluation where evaluation_group_id like 'solve_%' order by created_at desc limit 12;
COMMIT;

-- wrong-series-events 2026-10-10T04:32:23.092509+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select * from event where created_at>='2026-10-10T04:32:22.789530+00:00' and (action like '%assessment%' or action like '%nudge%' or action like '%failure%') order by created_at;
COMMIT;

-- wrong-series-after 2026-10-10T04:32:23.142495+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select * from mastery_state where subject_id in (select jsonb_array_elements_text(knowledge_ids) from question where id='v1zkg2mrb3no3qc9ziv4fhov');
COMMIT;

-- m34-runs 2026-10-10T04:32:42.686708+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select id,task_kind,provider,model,status,cost_usd,cost_basis,cost_ref,usage_json,input_hash,result_digest,started_at,finished_at,error_message from ai_task_runs where started_at >= '2026-10-10T04:12:11.440031+00:00' order by started_at;
COMMIT;

-- m34-attempts 2026-10-10T04:32:42.993115+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select attempt_id,attempt_kind,provider,model,operation_kind,terminal_status,wire_count,cost_basis,cost_amount,cost_currency,usage_json,started_at,finished_at from provider_attempt where started_at >= '2026-10-10T04:12:11.440031+00:00' order by started_at;
COMMIT;

-- m34-iterations 2026-10-10T04:32:43.054067+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select task_run_id,max(iteration)+1 n from tool_call_log where occurred_at >= '2026-10-10T04:12:11.440031+00:00' and tool_name like 'mcp__%' group by 1;
COMMIT;

-- r01-jobs-34 2026-10-10T04:32:43.109079+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select name,state,count(*) n from pgboss.job where created_on>='2026-10-10T04:12:11.440031+00:00' group by name,state order by name,state;
COMMIT;

-- wrong-followup-events-34 2026-10-10T04:32:43.168677+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select subject_id,action,count(*) n from event where created_at>='2026-10-10T04:33:00Z' and (action like '%nudge%' or action like '%failure%' or action like '%assessment%') group by 1,2;
COMMIT;

-- assisted-before-0 2026-10-10T04:33:07.152135+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select * from mastery_state where subject_id in (select jsonb_array_elements_text(knowledge_ids) from question where id='v1zkg2mrb3no3qc9ziv4fhov');
COMMIT;

-- assisted-after-0 2026-10-10T04:33:07.512276+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select * from mastery_state where subject_id in (select jsonb_array_elements_text(knowledge_ids) from question where id='v1zkg2mrb3no3qc9ziv4fhov');
COMMIT;

-- assisted-before-1 2026-10-10T04:33:07.602893+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select * from mastery_state where subject_id in (select jsonb_array_elements_text(knowledge_ids) from question where id='v1zkg2mrb3no3qc9ziv4fhov');
COMMIT;

-- assisted-after-1 2026-10-10T04:33:07.713359+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select * from mastery_state where subject_id in (select jsonb_array_elements_text(knowledge_ids) from question where id='v1zkg2mrb3no3qc9ziv4fhov');
COMMIT;

-- assisted-events 2026-10-10T04:33:07.787183+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select id,action,subject_id,payload from event where action in ('experimental:assessment_assistance','experimental:assessment_submission','experimental:assessment_settlement') and created_at>='2026-10-10T04:33:07.454736+00:00' order by created_at;
COMMIT;

-- r01-sessions-now 2026-10-10T04:33:23.678204+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select id,type,status,entrypoint,started_at,ended_at,summary_md from learning_session where created_at>='2026-10-10T04:12:11.440031+00:00' order by created_at;
COMMIT;

-- native-nudge-jobs 2026-10-10T04:33:23.895883+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select id,name,state,data,created_on,completed_on,output from pgboss.job where name='copilot_nudge_evaluate' and created_on>='2026-10-10T04:12:11.440031+00:00';
COMMIT;

-- native-nudges 2026-10-10T04:33:23.973620+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select id,action,subject_id,outcome,payload,created_at from event where action like '%nudge%' and created_at>='2026-10-10T04:12:11.440031+00:00';
COMMIT;

-- native-deliveries 2026-10-10T04:33:24.065732+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select * from event_subscription_delivery where discovered_at>='2026-10-10T04:32:00Z';
COMMIT;

-- m35-runs 2026-10-10T04:33:37.969465+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select id,task_kind,provider,model,status,cost_usd,cost_basis,cost_ref,usage_json,input_hash,result_digest,started_at,finished_at,error_message from ai_task_runs where started_at >= '2026-10-10T04:12:11.440031+00:00' order by started_at;
COMMIT;

-- m35-attempts 2026-10-10T04:33:38.221415+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select attempt_id,attempt_kind,provider,model,operation_kind,terminal_status,wire_count,cost_basis,cost_amount,cost_currency,usage_json,started_at,finished_at from provider_attempt where started_at >= '2026-10-10T04:12:11.440031+00:00' order by started_at;
COMMIT;

-- m35-iterations 2026-10-10T04:33:38.285852+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select task_run_id,max(iteration)+1 n from tool_call_log where occurred_at >= '2026-10-10T04:12:11.440031+00:00' and tool_name like 'mcp__%' group by 1;
COMMIT;

-- checkpoint-final-progress 2026-10-10T04:34:05.344914+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select c.subscriber_id,c.status,c.next_delivery_seq,max(d.delivery_seq) max_delivery,count(*) filter(where d.status in ('pending','claimed','retry')) unfinished from event_subscription_checkpoint c left join event_subscription_delivery d using(subscriber_id) group by c.subscriber_id,c.status,c.next_delivery_seq;
COMMIT;

-- native-jobs-later 2026-10-10T04:34:05.612808+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select name,state,count(*) n from pgboss.job where created_on>='2026-10-10T04:32:00Z' and name not like '__%' group by name,state order by name,state;
COMMIT;

-- delivery-status-real 2026-10-10T04:34:23.663144+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select subscriber_id,status,count(*) n,min(discovered_at) oldest,max(completed_at) last_completed from event_subscription_delivery group by subscriber_id,status order by 1,2;
COMMIT;

-- attribution-live 2026-10-10T04:34:23.750428+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select id,name,state,created_on,completed_on,data from pgboss.job where created_on>='2026-10-10T04:32:00Z' and name like '%attribution%';
COMMIT;

-- brief-r01-current 2026-10-10T04:34:48.138647+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select id,scope_key,evidence_count,source_event_id,refreshed_at,latest_evidence_at from memory_brief_note where refreshed_at>='2026-10-10T04:12:11.440031+00:00';
COMMIT;

-- run-window-latest 2026-10-10T04:34:48.446152+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select task_kind,status,count(*) n from ai_task_runs where started_at>='2026-10-10T04:12:11.440031+00:00' group by 1,2 order by 1,2;
COMMIT;

-- note-timeout-receipt 2026-10-10T04:35:37.712824+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select id,task_kind,status,left(error_message,550) err,started_at,finished_at from ai_task_runs where task_kind='NoteGenerateTask' and started_at>='2026-10-10T04:12:11.440031+00:00' and status='failure';
COMMIT;

-- starter-later 2026-10-10T04:35:37.960476+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select id,status,last_error_class,last_error_code,last_error,known_cost_micro_usd from placement_starter_claim;
COMMIT;

-- notes-later 2026-10-10T04:35:38.016576+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select name,state,count(*) n from pgboss.job where name='note_generate' and created_on>='2026-10-10T04:12:11.440031+00:00' group by 1,2;
COMMIT;

-- m37-runs 2026-10-10T04:35:38.071407+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select id,task_kind,provider,model,status,cost_usd,cost_basis,cost_ref,usage_json,input_hash,result_digest,started_at,finished_at,error_message from ai_task_runs where started_at >= '2026-10-10T04:12:11.440031+00:00' order by started_at;
COMMIT;

-- m37-attempts 2026-10-10T04:35:38.127294+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select attempt_id,attempt_kind,provider,model,operation_kind,terminal_status,wire_count,cost_basis,cost_amount,cost_currency,usage_json,started_at,finished_at from provider_attempt where started_at >= '2026-10-10T04:12:11.440031+00:00' order by started_at;
COMMIT;

-- m37-iterations 2026-10-10T04:35:38.177170+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select task_run_id,max(iteration)+1 n from tool_call_log where occurred_at >= '2026-10-10T04:12:11.440031+00:00' and tool_name like 'mcp__%' group by 1;
COMMIT;

-- starter-final 2026-10-10T04:36:05.162165+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select * from placement_starter_claim;
COMMIT;

-- starter-attempts-final 2026-10-10T04:36:05.456473+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select * from placement_starter_attempt;
COMMIT;

-- starter-questions-final 2026-10-10T04:36:05.509773+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select * from placement_starter_attempt_question;
COMMIT;

-- starter-jobs-final 2026-10-10T04:36:05.562900+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select id,name,state,retry_count,retry_limit,data,created_on,started_on,completed_on,output from pgboss.job where id='15f1d9c8-e8b3-439a-8143-ea53ac109e04';
COMMIT;

-- native-help-effects 2026-10-10T04:36:05.617838+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select id,action,payload from event where action='experimental:assessment_settlement' and created_at>='2026-10-10T04:32:00Z';
COMMIT;

-- approval-metrics 2026-10-10T04:36:05.666990+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select action,payload->>'decision' decision,count(*) n,min(extract(epoch from(created_at))) min_at,max(extract(epoch from(created_at))) max_at from event where action in ('rate','experimental:completion_autoapply') group by action,payload->>'decision';
COMMIT;

-- shadow-counts 2026-10-10T04:36:05.721359+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select action,payload->>'shadow' shadow,count(*) n from event where action like '%nudge%' or action like '%intervention%' group by action,payload->>'shadow';
COMMIT;

-- memory-flat-metadata-sample 2026-10-10T04:36:38.431192+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select id,payload-'data' metadata from learning_project_memories limit 4;
COMMIT;

-- memory-lineage-corrected 2026-10-10T04:36:50.174730+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select m.id,m.payload->>'event_id' source_event_id,e.action,e.created_at,m.payload->>'createdAt' memory_created_at,md5(m.payload::text) digest from learning_project_memories m left join event e on e.id=m.payload->>'event_id' order by m.id;
COMMIT;

-- retracted-memory-source-join 2026-10-10T04:37:05.553111+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
with targets as(select c.id correction_id,c.created_at correction_at,t->>'id' target_id from event c cross join lateral jsonb_array_elements(c.payload->'affected_refs') t where c.action='correct' and c.payload->>'correction_kind'='retract') select t.*,m.id memory_id,m.payload->>'createdAt' memory_created_at from targets t left join learning_project_memories m on m.payload->>'event_id'=t.target_id;
COMMIT;

-- m39-runs 2026-10-10T04:38:02.088694+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select id,task_kind,provider,model,status,cost_usd,cost_basis,cost_ref,usage_json,input_hash,result_digest,started_at,finished_at,error_message from ai_task_runs where started_at >= '2026-10-10T04:12:11.440031+00:00' order by started_at;
COMMIT;

-- m39-attempts 2026-10-10T04:38:02.383125+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select attempt_id,attempt_kind,provider,model,operation_kind,terminal_status,wire_count,cost_basis,cost_amount,cost_currency,usage_json,started_at,finished_at from provider_attempt where started_at >= '2026-10-10T04:12:11.440031+00:00' order by started_at;
COMMIT;

-- m39-iterations 2026-10-10T04:38:02.451106+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select task_run_id,max(iteration)+1 n from tool_call_log where occurred_at >= '2026-10-10T04:12:11.440031+00:00' and tool_name like 'mcp__%' group by 1;
COMMIT;

-- native-settlements-final 2026-10-10T04:38:02.509536+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select id,action,payload,outcome,created_at from event where action='experimental:assessment_settlement' and created_at>='2026-10-10T04:32:00Z';
COMMIT;

-- live-flow-jobs-39 2026-10-10T04:38:02.564507+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select id,name,state,retry_count,retry_limit,created_on,started_on,completed_on,left(output::text,1100) output from pgboss.job where name in ('note_generate','note_generate_dlq','quiz_gen','quiz_gen_dlq','tencent_ocr_extract_dlq') and created_on>='2026-10-10T04:12:11.440031+00:00';
COMMIT;

-- delivery-38 2026-10-10T04:38:27.451338+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select subscriber_id,status,count(*) n from event_subscription_delivery group by 1,2 order by 1,2;
COMMIT;

-- running-38 2026-10-10T04:38:27.744921+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select id,task_kind,status,started_at,finished_at from ai_task_runs where status='running';
COMMIT;

-- accept-root-identity 2026-10-10T04:38:58.821612+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select k.id,k.name,k.parent_id,k.domain,k.proposed_by_ai,k.approval_status,(select count(*) from goal g where g.source_ref=k.id or g.scope_knowledge_ids ? k.id) goals_referencing_root,(select count(*) from learning_item l where l.knowledge_ids ? k.id) learning_items,(select count(*) from mastery_state m where m.subject_id=k.id) mastery_rows from knowledge k where k.id in ('knxrz3pjyg1d9b0deioae1ov','si6lqci2xbapy4j5k37ngzaw');
COMMIT;

-- baseline-root-state 2026-10-10T04:38:59.142774+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select k.id,k.name,m.theta_hat,m.evidence_count,m.success_count,m.fail_count from knowledge k join mastery_state m on m.subject_id=k.id where k.name like '%系统性%';
COMMIT;

-- objective-slots-census 2026-10-10T04:38:59.225647+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select r.group_id,count(*) assignments,r.execution_plan from question_group_lifecycle l join question_revision r on r.revision_id=l.current_revision_id group by r.group_id,r.execution_plan;
COMMIT;

-- read-census-counts 2026-10-10T04:38:59.294999+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select 'mastery_state' t,count(*) n from mastery_state union all select 'selection_observation',count(*) from selection_observation union all select 'difficulty_calibration_label',count(*) from difficulty_calibration_label union all select 'intervention',count(*) from intervention union all select 'editing_presence',count(*) from editing_presence union all select 'evaluation',count(*) from evaluation union all select 'learning_record',count(*) from learning_record union all select 'memory_reconciliation_log',count(*) from memory_reconciliation_log union all select 'learning_project_memories',count(*) from learning_project_memories;
COMMIT;

-- read-census-counts-corrected 2026-10-10T04:39:14.461770+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select 'mastery_state' kind,count(*) n from mastery_state union all select 'selection_observation',count(*) from selection_observation union all select 'difficulty_calibration_label',count(*) from difficulty_calibration_label union all select 'intervention',count(*) from intervention union all select 'editing_presence',count(*) from editing_presence union all select 'evaluation',count(*) from evaluation union all select 'learning_record',count(*) from learning_record union all select 'memory_reconciliation_log',count(*) from memory_reconciliation_log union all select 'learning_project_memories',count(*) from learning_project_memories;
COMMIT;

-- seal-pre-runs 2026-10-10T04:42:31.193845+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select id,task_kind,provider,model,status,cost_usd,cost_basis,cost_ref,usage_json,input_hash,result_digest,started_at,finished_at,error_message from ai_task_runs where started_at >= '2026-10-10T04:12:11.440031+00:00' order by started_at;
COMMIT;

-- seal-pre-attempts 2026-10-10T04:42:31.493193+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select attempt_id,attempt_kind,provider,model,operation_kind,terminal_status,wire_count,cost_basis,cost_amount,cost_currency,usage_json,started_at,finished_at from provider_attempt where started_at >= '2026-10-10T04:12:11.440031+00:00' order by started_at;
COMMIT;

-- seal-pre-iterations 2026-10-10T04:42:31.549217+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select task_run_id,max(iteration)+1 n from tool_call_log where occurred_at >= '2026-10-10T04:12:11.440031+00:00' and tool_name like 'mcp__%' group by 1;
COMMIT;

-- obligations-seal-pre 2026-10-10T04:42:31.608314+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select name,state,count(*) n from pgboss.job where created_on>='2026-10-10T04:12:11.440031+00:00' and name in ('note_generate','note_generate_dlq','memory_brief_regen','attribution_followup') group by 1,2;
COMMIT;

-- dlq-final-pre 2026-10-10T04:42:31.658928+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select name,state,count(*) n,min(created_on) oldest,max(extract(epoch from(now()-created_on))) oldest_age_s from pgboss.job where state='failed' or name like '%_dlq' group by name,state order by name,state;
COMMIT;

-- artifacts-seal-pre 2026-10-10T04:43:21.342683+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select id,type,title,generation_status,verification_status,jsonb_array_length(body_blocks->'content') blocks,version,created_at,updated_at from artifact where created_at>='2026-10-10T04:12:11.440031+00:00' order by created_at;
COMMIT;

-- write-delta-event 2026-10-10T04:43:39.147537+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select id,created_at from event where created_at>='2026-10-10T04:12:11.440031+00:00' order by created_at;
COMMIT;

-- write-delta-question 2026-10-10T04:43:39.396723+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select id,created_at from question where created_at>='2026-10-10T04:12:11.440031+00:00' order by created_at;
COMMIT;

-- write-delta-knowledge 2026-10-10T04:43:39.460737+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select id,created_at from knowledge where created_at>='2026-10-10T04:12:11.440031+00:00' order by created_at;
COMMIT;

-- write-delta-artifact 2026-10-10T04:43:39.521740+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select id,created_at from artifact where created_at>='2026-10-10T04:12:11.440031+00:00' order by created_at;
COMMIT;

-- write-delta-learning_item 2026-10-10T04:43:39.573806+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select id,created_at from learning_item where created_at>='2026-10-10T04:12:11.440031+00:00' order by created_at;
COMMIT;

-- write-delta-learning_record 2026-10-10T04:43:39.626655+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select id,created_at from learning_record where created_at>='2026-10-10T04:12:11.440031+00:00' order by created_at;
COMMIT;

-- write-delta-learning_session 2026-10-10T04:43:39.682412+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select id,created_at from learning_session where created_at>='2026-10-10T04:12:11.440031+00:00' order by created_at;
COMMIT;

-- write-delta-source_asset 2026-10-10T04:43:39.735054+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select id,created_at from source_asset where created_at>='2026-10-10T04:12:11.440031+00:00' order by created_at;
COMMIT;

-- write-delta-source_document 2026-10-10T04:43:39.785610+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select id,created_at from source_document where created_at>='2026-10-10T04:12:11.440031+00:00' order by created_at;
COMMIT;

-- write-delta-question_block 2026-10-10T04:43:39.834856+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select id,created_at from question_block where created_at>='2026-10-10T04:12:11.440031+00:00' order by created_at;
COMMIT;

-- write-delta-goal 2026-10-10T04:43:39.887533+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select id,created_at from goal where created_at>='2026-10-10T04:12:11.440031+00:00' order by created_at;
COMMIT;

-- write-delta-job_events 2026-10-10T04:43:39.938597+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select id,business_table,business_id,event_type,occurred_at from job_events where occurred_at>='2026-10-10T04:12:11.440031+00:00' order by occurred_at;
COMMIT;

-- note-ready-job 2026-10-10T04:44:04.187891+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select id,name,state,retry_count,retry_limit,data,created_on,started_on,completed_on,output from pgboss.job where name='note_generate' and data->>'artifact_id'='m4ma9a171zlplm919823x9a5';
COMMIT;

-- native-nudge-post-final 2026-10-10T04:44:41.511765+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select id,name,state,created_on,completed_on,data from pgboss.job where name='copilot_nudge_evaluate' and created_on>='2026-10-10T04:32:00Z';
COMMIT;

-- native-delivery-post-final 2026-10-10T04:44:41.810601+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select subscriber_id,status,count(*) n from event_subscription_delivery where discovered_at>='2026-10-10T04:32:00Z' group by 1,2;
COMMIT;

-- m44-runs 2026-10-10T04:44:59.682248+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select id,task_kind,provider,model,status,cost_usd,cost_basis,cost_ref,usage_json,input_hash,result_digest,started_at,finished_at,error_message from ai_task_runs where started_at >= '2026-10-10T04:12:11.440031+00:00' order by started_at;
COMMIT;

-- m44-attempts 2026-10-10T04:45:00.030534+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select attempt_id,attempt_kind,provider,model,operation_kind,terminal_status,wire_count,cost_basis,cost_amount,cost_currency,usage_json,started_at,finished_at from provider_attempt where started_at >= '2026-10-10T04:12:11.440031+00:00' order by started_at;
COMMIT;

-- m44-iterations 2026-10-10T04:45:00.081458+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select task_run_id,max(iteration)+1 n from tool_call_log where occurred_at >= '2026-10-10T04:12:11.440031+00:00' and tool_name like 'mcp__%' group by 1;
COMMIT;

-- obligations-44 2026-10-10T04:45:00.164745+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select name,state,count(*) n from pgboss.job where created_on>='2026-10-10T04:12:11.440031+00:00' and name in ('note_generate','note_generate_dlq','memory_brief_regen','attribution_followup') group by 1,2;
COMMIT;

-- provider-attempts-seal 2026-10-10T04:46:01.497085+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select * from provider_attempt where started_at>='2026-10-10T04:12:11.440031+00:00' order by started_at;
COMMIT;

-- cost-provenance 2026-10-10T04:46:14.217588+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select provider,model,task_kind,cost_basis,cost_ref,count(*) n from ai_task_runs where started_at>='2026-10-10T04:12:11.440031+00:00' group by 1,2,3,4,5;
COMMIT;

-- seal-final-runs 2026-10-10T04:50:46.302993+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select id,task_kind,provider,model,status,cost_usd,cost_basis,cost_ref,usage_json,input_hash,result_digest,started_at,finished_at,error_message from ai_task_runs where started_at >= '2026-10-10T04:12:11.440031+00:00' order by started_at;
COMMIT;

-- seal-final-attempts 2026-10-10T04:50:46.606904+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select attempt_id,attempt_kind,provider,model,operation_kind,terminal_status,wire_count,cost_basis,cost_amount,cost_currency,usage_json,started_at,finished_at from provider_attempt where started_at >= '2026-10-10T04:12:11.440031+00:00' order by started_at;
COMMIT;

-- seal-final-iterations 2026-10-10T04:50:46.666517+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select task_run_id,max(iteration)+1 n from tool_call_log where occurred_at >= '2026-10-10T04:12:11.440031+00:00' and tool_name like 'mcp__%' group by 1;
COMMIT;

-- jobs-seal-final 2026-10-10T04:50:46.720022+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select id,name,state,retry_count,retry_limit,data,created_on,started_on,completed_on,output from pgboss.job where created_on >= '2026-10-10T04:12:11.440031+00:00' and name in ('note_generate','note_generate_dlq','quiz_gen','quiz_gen_dlq','ocr_extract','ocr_extract_dlq','memory_brief_regen','memory_event_ingest','memory_reconcile','attribution_followup','note_verify','note_verify_dlq') order by created_on;
COMMIT;

-- dlq-seal-final 2026-10-10T04:50:46.776852+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select name,state,count(*) n,min(created_on) oldest,max(created_on) newest from pgboss.job where state='failed' or name like '%_dlq' group by 1,2 order by 1,2;
COMMIT;

-- artifacts-seal-final 2026-10-10T04:50:46.840968+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select id,type,title,generation_status,verification_status,jsonb_array_length(body_json->'blocks') blocks,version,created_at,updated_at from artifact where created_at>='2026-10-10T04:14:57Z' and created_at <'2026-10-10T04:15:00Z' order by created_at,id;
COMMIT;

-- artifacts-seal-final 2026-10-10T04:51:09.721076+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select id,type,title,generation_status,verification_status,jsonb_array_length(body_blocks->'content') blocks,version,created_at,updated_at from artifact where created_at>='2026-10-10T04:14:57Z' and created_at <'2026-10-10T04:15:00Z' order by created_at,id;
COMMIT;

-- seal-final-runs 2026-10-10T04:52:32.664694+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select id,task_kind,provider,model,status,cost_usd,cost_basis,cost_ref,usage_json,input_hash,result_digest,started_at,finished_at,error_message from ai_task_runs where started_at >= '2026-10-10T04:12:11.440031+00:00' order by started_at;
COMMIT;

-- seal-final-attempts 2026-10-10T04:52:33.091465+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select attempt_id,attempt_kind,provider,model,operation_kind,terminal_status,wire_count,cost_basis,cost_amount,cost_currency,usage_json,started_at,finished_at from provider_attempt where started_at >= '2026-10-10T04:12:11.440031+00:00' order by started_at;
COMMIT;

-- seal-final-iterations 2026-10-10T04:52:33.160672+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select task_run_id,max(iteration)+1 n from tool_call_log where occurred_at >= '2026-10-10T04:12:11.440031+00:00' and tool_name like 'mcp__%' group by 1;
COMMIT;

-- jobs-seal-final 2026-10-10T04:52:33.226283+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select id,name,state,retry_count,retry_limit,data,created_on,started_on,completed_on,output from pgboss.job where created_on>='2026-10-10T04:12:11.440031+00:00' order by created_on;
COMMIT;

-- provider-attempts-final 2026-10-10T04:52:33.295233+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select * from provider_attempt where started_at>='2026-10-10T04:12:11.440031+00:00' order by started_at;
COMMIT;

-- artifacts-seal-final 2026-10-10T04:52:33.347119+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select id,type,title,generation_status,verification_status,jsonb_array_length(body_blocks->'content') blocks,version,created_at,updated_at from artifact where created_at>='2026-10-10T04:12:11.440031+00:00' order by created_at,id;
COMMIT;

-- dlq-seal-final 2026-10-10T04:52:33.396302+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select name,state,count(*) n,min(created_on) oldest,max(created_on) newest,extract(epoch from now()-min(created_on)) oldest_age_s from pgboss.job where state='failed' or name like '%_dlq' group by 1,2 order by 1,2;
COMMIT;

-- write-final-event 2026-10-10T04:52:33.455340+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select id,action,created_at from event where created_at>='2026-10-10T04:12:11.440031+00:00' order by created_at;
COMMIT;

-- write-final-artifact 2026-10-10T04:52:33.508810+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select id,generation_status,verification_status,updated_at from artifact where created_at>='2026-10-10T04:12:11.440031+00:00' order by created_at;
COMMIT;

-- write-final-job_events 2026-10-10T04:52:33.562107+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select id,business_table,business_id,event_type,occurred_at from job_events where occurred_at>='2026-10-10T04:12:11.440031+00:00' order by occurred_at;
COMMIT;

-- seal-final-runs 2026-10-10T04:56:40.913296+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select id,task_kind,provider,model,status,cost_usd,cost_basis,cost_ref,usage_json,input_hash,result_digest,started_at,finished_at,error_message from ai_task_runs where started_at >= '2026-10-10T04:12:11.440031+00:00' order by started_at;
COMMIT;

-- seal-final-attempts 2026-10-10T04:56:41.236917+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select attempt_id,attempt_kind,provider,model,operation_kind,terminal_status,wire_count,cost_basis,cost_amount,cost_currency,usage_json,started_at,finished_at from provider_attempt where started_at >= '2026-10-10T04:12:11.440031+00:00' order by started_at;
COMMIT;

-- seal-final-iterations 2026-10-10T04:56:41.294422+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select task_run_id,max(iteration)+1 n from tool_call_log where occurred_at >= '2026-10-10T04:12:11.440031+00:00' and tool_name like 'mcp__%' group by 1;
COMMIT;

-- jobs-seal-final 2026-10-10T04:56:41.346626+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select id,name,state,retry_count,retry_limit,data,created_on,started_on,completed_on,output from pgboss.job where created_on>='2026-10-10T04:12:11.440031+00:00' order by created_on;
COMMIT;

-- provider-attempts-final 2026-10-10T04:56:41.411672+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select * from provider_attempt where started_at>='2026-10-10T04:12:11.440031+00:00' order by started_at;
COMMIT;

-- artifacts-seal-final 2026-10-10T04:56:41.475434+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select id,type,title,generation_status,verification_status,jsonb_array_length(body_blocks->'content') blocks,version,created_at,updated_at from artifact where created_at>='2026-10-10T04:12:11.440031+00:00' order by created_at,id;
COMMIT;

-- dlq-seal-final 2026-10-10T04:56:41.529348+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select name,state,count(*) n,min(created_on) oldest,max(created_on) newest,extract(epoch from now()-min(created_on)) oldest_age_s from pgboss.job where state='failed' or name like '%_dlq' group by 1,2 order by 1,2;
COMMIT;

-- write-final-event 2026-10-10T04:56:41.592031+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select id,action,created_at from event where created_at>='2026-10-10T04:12:11.440031+00:00' order by created_at;
COMMIT;

-- write-final-artifact 2026-10-10T04:56:41.646954+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select id,generation_status,verification_status,updated_at from artifact where created_at>='2026-10-10T04:12:11.440031+00:00' order by created_at;
COMMIT;

-- write-final-job_events 2026-10-10T04:56:41.699192+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select id,business_table,business_id,event_type,occurred_at from job_events where occurred_at>='2026-10-10T04:12:11.440031+00:00' order by occurred_at;
COMMIT;

-- copilot-operations-harness-recheck 2026-10-10T04:58:00.860204+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select * from tool_operation where id like 'copilot%' order by created_at desc limit 10;
COMMIT;

-- mcq-frozen-harness-recheck 2026-10-10T04:58:01.197796+00:00
BEGIN READ ONLY; SET LOCAL statement_timeout='15s';
select * from question_revision where group_id='i2ytzyvs4h8uy1f9hcvp09r9' order by created_at desc limit 1;
COMMIT;
