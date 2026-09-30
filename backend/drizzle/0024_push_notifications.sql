-- Web push notifications (ADR-065).
--
-- One row per browser install that has granted notification permission. The
-- endpoint is the push service's URL for that install (FCM for Chrome, Mozilla
-- autopush for Firefox, Apple for Safari) and is globally unique, so a browser
-- that subscribes again updates its row rather than adding a second one.
--
-- p256dh and auth are the browser's public key material from
-- PushSubscription.toJSON(); they let the server encrypt a message only that
-- browser can read. They are not secrets that authenticate *us* to anything.
CREATE TABLE IF NOT EXISTS "push_subscriptions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "endpoint" text NOT NULL,
  "p256dh" text NOT NULL,
  "auth" text NOT NULL,
  "user_agent" text,
  "last_success_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "push_subscriptions_endpoint_unique"
  ON "push_subscriptions" ("endpoint");

CREATE INDEX IF NOT EXISTS "push_subscriptions_user_idx"
  ON "push_subscriptions" ("user_id");

-- Per-user opt-in per event. A missing row means every default is on.
CREATE TABLE IF NOT EXISTS "notification_preferences" (
  "user_id" uuid PRIMARY KEY NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "approval_required" boolean DEFAULT true NOT NULL,
  "task_completed" boolean DEFAULT true NOT NULL,
  "task_failed" boolean DEFAULT true NOT NULL,
  "sound_enabled" boolean DEFAULT true NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
