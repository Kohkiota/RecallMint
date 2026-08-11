ALTER TABLE "cards" ALTER COLUMN "answered" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "cards" ALTER COLUMN "current_streak" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "cards" ALTER COLUMN "due" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "cards" ALTER COLUMN "stability" SET DATA TYPE double precision;--> statement-breakpoint
ALTER TABLE "cards" ALTER COLUMN "stability" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "cards" ALTER COLUMN "difficulty" SET DATA TYPE double precision;--> statement-breakpoint
ALTER TABLE "cards" ALTER COLUMN "difficulty" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "cards" ALTER COLUMN "elapsed_days" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "cards" ALTER COLUMN "scheduled_days" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "cards" ALTER COLUMN "reps" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "cards" ALTER COLUMN "lapses" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "cards" ALTER COLUMN "state" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "cards" ALTER COLUMN "learning_steps" DROP DEFAULT;--> statement-breakpoint
ALTER TABLE "cards" ADD CONSTRAINT "cards_state_range" CHECK ("cards"."state" BETWEEN 0 AND 3);