-- One row per provider (ADR-023 extended). Additive: existing rows become
-- priority 1 with a label derived from their provider, and keep their keys.
ALTER TABLE "organization_model_settings" ADD COLUMN IF NOT EXISTS "id" uuid DEFAULT gen_random_uuid();
--> statement-breakpoint
ALTER TABLE "organization_model_settings" ADD COLUMN IF NOT EXISTS "priority" integer DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE "organization_model_settings" ADD COLUMN IF NOT EXISTS "label" text;
--> statement-breakpoint
ALTER TABLE "organization_model_settings" ADD COLUMN IF NOT EXISTS "enabled" boolean DEFAULT true NOT NULL;
--> statement-breakpoint
ALTER TABLE "organization_model_settings" ADD COLUMN IF NOT EXISTS "structured_outputs" boolean;
--> statement-breakpoint
UPDATE "organization_model_settings" SET "id" = gen_random_uuid() WHERE "id" IS NULL;
--> statement-breakpoint
UPDATE "organization_model_settings"
   SET "label" = CASE
     WHEN "provider_id" = 'mock' THEN 'No model (scripted)'
     WHEN "provider_id" = 'anthropic' THEN 'Anthropic'
     ELSE COALESCE("model", 'OpenAI-compatible endpoint')
   END
 WHERE "label" IS NULL;
--> statement-breakpoint
ALTER TABLE "organization_model_settings" ALTER COLUMN "id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "organization_model_settings" DROP CONSTRAINT IF EXISTS "organization_model_settings_pkey";
--> statement-breakpoint
ALTER TABLE "organization_model_settings" ADD PRIMARY KEY ("id");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "organization_model_settings_priority_idx" ON "organization_model_settings" ("organization_id","priority");
