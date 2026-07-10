CREATE TABLE "integration_failures" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"service" text NOT NULL,
	"operation" text NOT NULL,
	"workflow" text,
	"failure_code" text NOT NULL,
	"user_id" uuid,
	"clerk_id" text,
	"stripe_customer_id" text,
	"stripe_subscription_id" text,
	"schedule_id" text,
	"context" jsonb NOT NULL,
	"error_message" text,
	"retry_count" integer DEFAULT 0 NOT NULL,
	"next_retry_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"resolution_note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP TABLE "deletion_failures" CASCADE;