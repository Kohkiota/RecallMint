ALTER TABLE "source_assets" ALTER COLUMN "mime" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "source_assets" ALTER COLUMN "content_hash" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "source_assets" ALTER COLUMN "byte_size" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "source_assets" ALTER COLUMN "width" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "source_assets" ALTER COLUMN "height" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "upload_operations" DROP COLUMN "input_fingerprint";