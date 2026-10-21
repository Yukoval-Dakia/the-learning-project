CREATE TABLE "custom_provider" (
	"id" text PRIMARY KEY NOT NULL,
	"display_name" text NOT NULL,
	"base_url" text NOT NULL,
	"api_key_env" text NOT NULL,
	"protocol" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "custom_provider_id_prefix_ck" CHECK ("custom_provider"."id" LIKE 'custom:%'),
	CONSTRAINT "custom_provider_protocol_ck" CHECK ("custom_provider"."protocol" IN ('openai-completions', 'anthropic-messages')),
	CONSTRAINT "custom_provider_base_url_ck" CHECK ("custom_provider"."base_url" LIKE 'https://%' AND "custom_provider"."base_url" NOT LIKE '%@%' AND "custom_provider"."base_url" NOT LIKE '%?%' AND "custom_provider"."base_url" NOT LIKE '%#%')
);
