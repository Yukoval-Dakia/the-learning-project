ALTER TABLE "tool_operation" ADD CONSTRAINT "tool_operation_identity_bounds_ck" CHECK (char_length("tool_operation"."id") BETWEEN 1 AND 256
        AND char_length("tool_operation"."tool_name") BETWEEN 1 AND 256
        AND char_length("tool_operation"."process_id") BETWEEN 1 AND 256
        AND ("tool_operation"."session_id" IS NULL OR char_length("tool_operation"."session_id") BETWEEN 1 AND 256)
        AND ("tool_operation"."task_run_id" IS NULL OR char_length("tool_operation"."task_run_id") BETWEEN 1 AND 256)
        AND ("tool_operation"."terminal_tool_call_log_id" IS NULL
          OR char_length("tool_operation"."terminal_tool_call_log_id") BETWEEN 1 AND 256));--> statement-breakpoint
ALTER TABLE "tool_operation" ADD CONSTRAINT "tool_operation_json_bounds_ck" CHECK (jsonb_typeof("tool_operation"."input_json") = 'object'
        AND octet_length("tool_operation"."input_json"::text) <= 131072
        AND ("tool_operation"."result_json" IS NULL OR (
          jsonb_typeof("tool_operation"."result_json") = 'object'
          AND octet_length("tool_operation"."result_json"::text) <= 131072
        )));--> statement-breakpoint
ALTER TABLE "tool_operation" ADD CONSTRAINT "tool_operation_error_bounds_ck" CHECK ("tool_operation"."error_json" IS NULL OR (
        jsonb_typeof("tool_operation"."error_json") = 'object'
        AND "tool_operation"."error_json" ? 'code'
        AND "tool_operation"."error_json" ? 'message'
        AND char_length("tool_operation"."error_json"->>'code') BETWEEN 1 AND 100
        AND char_length("tool_operation"."error_json"->>'message') BETWEEN 1 AND 4000
      ));
