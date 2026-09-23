CREATE TYPE "public"."corporate_action_source" AS ENUM('detected', 'manual');--> statement-breakpoint
CREATE TYPE "public"."corporate_action_type" AS ENUM('split', 'bonus', 'consolidation');--> statement-breakpoint
CREATE TYPE "public"."exchange" AS ENUM('NSE', 'BSE');--> statement-breakpoint
CREATE TYPE "public"."exit_reason" AS ENUM('stop_loss', 'target', 'trailing_stop', 'time_exit');--> statement-breakpoint
CREATE TYPE "public"."ingestion_status" AS ENUM('pending', 'success', 'failed', 'no_data');--> statement-breakpoint
CREATE TYPE "public"."scan_run_status" AS ENUM('running', 'completed', 'failed');--> statement-breakpoint
CREATE TABLE "backtests" (
	"id" serial PRIMARY KEY NOT NULL,
	"symbol_id" integer NOT NULL,
	"strategy_id" integer NOT NULL,
	"run_at" timestamp with time zone DEFAULT now() NOT NULL,
	"params" jsonb NOT NULL,
	"metrics" jsonb NOT NULL,
	"equity_curve" jsonb,
	"trades" jsonb
);
--> statement-breakpoint
CREATE TABLE "corporate_actions" (
	"id" serial PRIMARY KEY NOT NULL,
	"symbol_id" integer NOT NULL,
	"ex_date" date NOT NULL,
	"type" "corporate_action_type" NOT NULL,
	"ratio_numerator" integer NOT NULL,
	"ratio_denominator" integer NOT NULL,
	"adj_factor" numeric(10, 6) NOT NULL,
	"source" "corporate_action_source" NOT NULL,
	"confirmed" boolean DEFAULT false NOT NULL,
	"notes" text
);
--> statement-breakpoint
CREATE TABLE "daily_bars" (
	"symbol_id" integer NOT NULL,
	"date" date NOT NULL,
	"prev_close" numeric(14, 4),
	"open" numeric(14, 4),
	"high" numeric(14, 4),
	"low" numeric(14, 4),
	"last" numeric(14, 4),
	"close" numeric(14, 4),
	"vwap" numeric(14, 4),
	"volume" bigint,
	"turnover" numeric(18, 2),
	"trades" bigint,
	"delivery_qty" bigint,
	"delivery_pct" numeric(5, 2),
	CONSTRAINT "daily_bars_symbol_id_date_pk" PRIMARY KEY("symbol_id","date")
);
--> statement-breakpoint
CREATE TABLE "ingestion_log" (
	"exchange" "exchange" NOT NULL,
	"date" date NOT NULL,
	"status" "ingestion_status" NOT NULL,
	"rows_ingested" integer,
	"error" text,
	"completed_at" timestamp with time zone,
	CONSTRAINT "ingestion_log_exchange_date_pk" PRIMARY KEY("exchange","date")
);
--> statement-breakpoint
CREATE TABLE "scan_runs" (
	"id" serial PRIMARY KEY NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"finished_at" timestamp with time zone,
	"universe_size" integer,
	"symbols_with_signals" integer,
	"params_snapshot" jsonb,
	"status" "scan_run_status" DEFAULT 'running' NOT NULL,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "signals" (
	"id" serial PRIMARY KEY NOT NULL,
	"symbol_id" integer NOT NULL,
	"strategy_id" integer NOT NULL,
	"signal_date" date NOT NULL,
	"window_start" date NOT NULL,
	"window_end" date NOT NULL,
	"avg_ratio" numeric(8, 4),
	"min_ratio" numeric(8, 4),
	"trades_ratio" numeric(8, 4),
	"price_change_pct" numeric(8, 4),
	"up_days" integer,
	"avg_delivery_pct" numeric(5, 2),
	"baseline_delivery" bigint,
	"baseline_trades" bigint,
	"entry_price" numeric(14, 4),
	"fwd_1" numeric(8, 4),
	"fwd_3" numeric(8, 4),
	"fwd_5" numeric(8, 4),
	"fwd_10" numeric(8, 4),
	"fwd_20" numeric(8, 4),
	"mfe_10" numeric(8, 4),
	"mae_10" numeric(8, 4),
	"exit_reason" "exit_reason",
	"realized_return" numeric(8, 4)
);
--> statement-breakpoint
CREATE TABLE "strategies" (
	"id" serial PRIMARY KEY NOT NULL,
	"symbol_id" integer NOT NULL,
	"name" text NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"params" jsonb NOT NULL,
	"tuning" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "symbols" (
	"id" serial PRIMARY KEY NOT NULL,
	"exchange" "exchange" NOT NULL,
	"symbol" text NOT NULL,
	"isin" text,
	"name" text,
	"series" text NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"first_seen" date NOT NULL,
	"last_seen" date NOT NULL
);
--> statement-breakpoint
ALTER TABLE "backtests" ADD CONSTRAINT "backtests_symbol_id_symbols_id_fk" FOREIGN KEY ("symbol_id") REFERENCES "public"."symbols"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "backtests" ADD CONSTRAINT "backtests_strategy_id_strategies_id_fk" FOREIGN KEY ("strategy_id") REFERENCES "public"."strategies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "corporate_actions" ADD CONSTRAINT "corporate_actions_symbol_id_symbols_id_fk" FOREIGN KEY ("symbol_id") REFERENCES "public"."symbols"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "daily_bars" ADD CONSTRAINT "daily_bars_symbol_id_symbols_id_fk" FOREIGN KEY ("symbol_id") REFERENCES "public"."symbols"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signals" ADD CONSTRAINT "signals_symbol_id_symbols_id_fk" FOREIGN KEY ("symbol_id") REFERENCES "public"."symbols"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "signals" ADD CONSTRAINT "signals_strategy_id_strategies_id_fk" FOREIGN KEY ("strategy_id") REFERENCES "public"."strategies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "strategies" ADD CONSTRAINT "strategies_symbol_id_symbols_id_fk" FOREIGN KEY ("symbol_id") REFERENCES "public"."symbols"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "daily_bars_date_idx" ON "daily_bars" USING btree ("date");--> statement-breakpoint
CREATE INDEX "signals_symbol_id_signal_date_idx" ON "signals" USING btree ("symbol_id","signal_date");--> statement-breakpoint
CREATE INDEX "strategies_symbol_id_idx" ON "strategies" USING btree ("symbol_id");--> statement-breakpoint
CREATE UNIQUE INDEX "symbols_exchange_symbol_series_unique" ON "symbols" USING btree ("exchange","symbol","series");--> statement-breakpoint
CREATE INDEX "symbols_isin_idx" ON "symbols" USING btree ("isin");