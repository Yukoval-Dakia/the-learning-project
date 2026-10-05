ALTER TABLE "ai_task_runs" ADD COLUMN "compiled_prompt_hash" text;--> statement-breakpoint
ALTER TABLE "ai_task_runs" ADD COLUMN "prompt_codec_version" text;--> statement-breakpoint
ALTER TABLE "ai_task_runs" ADD COLUMN "prompt_codec_mode" text;--> statement-breakpoint
ALTER TABLE "ai_task_runs" ADD COLUMN "prompt_context_digest" text;--> statement-breakpoint
ALTER TABLE "ai_task_runs" ADD CONSTRAINT "ai_task_runs_compiled_prompt_provenance_ck" CHECK ((
        "ai_task_runs"."compiled_prompt_hash" IS NULL
        AND "ai_task_runs"."prompt_codec_version" IS NULL
        AND "ai_task_runs"."prompt_codec_mode" IS NULL
        AND "ai_task_runs"."prompt_context_digest" IS NULL
      ) OR (
        "ai_task_runs"."compiled_prompt_hash" IS NOT NULL
        AND "ai_task_runs"."compiled_prompt_hash" ~ '^[0-9a-f]{64}$'
        AND "ai_task_runs"."prompt_codec_version" IS NOT NULL
        AND btrim("ai_task_runs"."prompt_codec_version") <> ''
        AND "ai_task_runs"."prompt_codec_mode" IS NOT NULL
        AND "ai_task_runs"."prompt_codec_mode" IN ('cold','resume')
        AND "ai_task_runs"."prompt_context_digest" IS NOT NULL
        AND "ai_task_runs"."prompt_context_digest" ~ '^[0-9a-f]{64}$'
      ));
