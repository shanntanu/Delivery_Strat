CREATE TYPE "public"."run_type" AS ENUM('scan', 'tune', 'universe');--> statement-breakpoint
ALTER TABLE "scan_runs" ADD COLUMN "run_type" "run_type" DEFAULT 'scan' NOT NULL;