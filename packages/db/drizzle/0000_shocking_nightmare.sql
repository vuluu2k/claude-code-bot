CREATE TYPE "public"."task_status" AS ENUM('queued', 'running', 'succeeded', 'failed', 'cancelled', 'timeout');--> statement-breakpoint
CREATE TABLE "repos" (
	"slug" text PRIMARY KEY NOT NULL,
	"remote_url" text NOT NULL,
	"default_branch" text DEFAULT 'main' NOT NULL,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"repo_slug" text NOT NULL,
	"title" text,
	"summary" text,
	"claude_session_id" text,
	"metadata" jsonb DEFAULT '{}'::jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "task_logs" (
	"id" text PRIMARY KEY NOT NULL,
	"task_id" text NOT NULL,
	"stream" text NOT NULL,
	"chunk" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" text PRIMARY KEY NOT NULL,
	"repo_slug" text NOT NULL,
	"session_id" text,
	"status" "task_status" DEFAULT 'queued' NOT NULL,
	"prompt" text NOT NULL,
	"requested_by" text,
	"channel_id" text,
	"worktree_path" text,
	"branch" text,
	"diff_summary" text,
	"exit_code" integer,
	"error" text,
	"started_at" timestamp with time zone,
	"finished_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "threads" (
	"id" text PRIMARY KEY NOT NULL,
	"repo_slug" text NOT NULL,
	"channel_id" text,
	"created_by" text,
	"worktree_path" text,
	"branch" text,
	"claude_session_id" text,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_repo_slug_repos_slug_fk" FOREIGN KEY ("repo_slug") REFERENCES "public"."repos"("slug") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_logs" ADD CONSTRAINT "task_logs_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_repo_slug_repos_slug_fk" FOREIGN KEY ("repo_slug") REFERENCES "public"."repos"("slug") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_session_id_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."sessions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "threads" ADD CONSTRAINT "threads_repo_slug_repos_slug_fk" FOREIGN KEY ("repo_slug") REFERENCES "public"."repos"("slug") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "repos_remote_url_idx" ON "repos" USING btree ("remote_url");--> statement-breakpoint
CREATE INDEX "sessions_repo_idx" ON "sessions" USING btree ("repo_slug");--> statement-breakpoint
CREATE INDEX "task_logs_task_idx" ON "task_logs" USING btree ("task_id","at");--> statement-breakpoint
CREATE INDEX "tasks_repo_idx" ON "tasks" USING btree ("repo_slug");--> statement-breakpoint
CREATE INDEX "tasks_status_idx" ON "tasks" USING btree ("status");--> statement-breakpoint
CREATE INDEX "tasks_created_idx" ON "tasks" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "threads_repo_idx" ON "threads" USING btree ("repo_slug");--> statement-breakpoint
CREATE INDEX "threads_status_idx" ON "threads" USING btree ("status");