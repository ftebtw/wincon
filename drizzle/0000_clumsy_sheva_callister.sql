CREATE TABLE "ai_analyses" (
	"id" serial PRIMARY KEY NOT NULL,
	"match_id" text NOT NULL,
	"puuid" text NOT NULL,
	"analysis_type" text NOT NULL,
	"analysis_json" jsonb NOT NULL,
	"coaching_text" text NOT NULL,
	"model_version" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "build_stats" (
	"id" serial PRIMARY KEY NOT NULL,
	"champion_id" integer NOT NULL,
	"role" text NOT NULL,
	"ally_comp_tags" jsonb NOT NULL,
	"enemy_comp_tags" jsonb NOT NULL,
	"item_build_path" jsonb NOT NULL,
	"sample_size" integer NOT NULL,
	"win_rate" numeric(5, 4) NOT NULL,
	"avg_game_length" integer NOT NULL,
	"patch" text NOT NULL,
	"computed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "match_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"match_id" text NOT NULL,
	"timestamp_ms" integer NOT NULL,
	"event_type" text NOT NULL,
	"killer_puuid" text,
	"victim_puuid" text,
	"assisting_puuids" jsonb,
	"position_x" integer,
	"position_y" integer,
	"event_data" jsonb
);
--> statement-breakpoint
CREATE TABLE "match_participants" (
	"id" serial PRIMARY KEY NOT NULL,
	"match_id" text NOT NULL,
	"puuid" text NOT NULL,
	"participant_id" integer NOT NULL,
	"team_id" integer NOT NULL,
	"champion_id" integer NOT NULL,
	"champion_name" text NOT NULL,
	"role" text NOT NULL,
	"win" boolean NOT NULL,
	"kills" integer NOT NULL,
	"deaths" integer NOT NULL,
	"assists" integer NOT NULL,
	"cs" integer NOT NULL,
	"gold_earned" integer NOT NULL,
	"damage_dealt" integer NOT NULL,
	"damage_taken" integer NOT NULL,
	"vision_score" integer NOT NULL,
	"items" jsonb NOT NULL,
	"runes" jsonb NOT NULL,
	"summoner_spells" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "matches" (
	"match_id" text PRIMARY KEY NOT NULL,
	"game_version" text NOT NULL,
	"game_mode" text NOT NULL,
	"game_duration" integer NOT NULL,
	"queue_id" integer NOT NULL,
	"map_id" integer NOT NULL,
	"game_start_ts" bigint NOT NULL,
	"winning_team" integer NOT NULL,
	"raw_data" jsonb NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "player_patterns" (
	"id" serial PRIMARY KEY NOT NULL,
	"puuid" text NOT NULL,
	"pattern_type" text NOT NULL,
	"frequency" numeric(5, 4) NOT NULL,
	"match_ids" jsonb NOT NULL,
	"details" jsonb NOT NULL,
	"last_computed" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "players" (
	"puuid" text PRIMARY KEY NOT NULL,
	"game_name" text NOT NULL,
	"tag_line" text NOT NULL,
	"summoner_id" text NOT NULL,
	"profile_icon_id" integer NOT NULL,
	"summoner_level" integer NOT NULL,
	"region" text DEFAULT 'na1' NOT NULL,
	"last_fetched" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ranked_stats" (
	"id" serial PRIMARY KEY NOT NULL,
	"puuid" text NOT NULL,
	"queue_type" text NOT NULL,
	"tier" text NOT NULL,
	"rank_division" text NOT NULL,
	"league_points" integer NOT NULL,
	"wins" integer NOT NULL,
	"losses" integer NOT NULL,
	"fetched_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "timeline_frames" (
	"id" serial PRIMARY KEY NOT NULL,
	"match_id" text NOT NULL,
	"frame_minute" integer NOT NULL,
	"puuid" text NOT NULL,
	"participant_id" integer NOT NULL,
	"gold" integer NOT NULL,
	"xp" integer NOT NULL,
	"cs" integer NOT NULL,
	"jungle_cs" integer NOT NULL,
	"level" integer NOT NULL,
	"position_x" integer,
	"position_y" integer
);
--> statement-breakpoint
ALTER TABLE "ai_analyses" ADD CONSTRAINT "ai_analyses_match_id_matches_match_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."matches"("match_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_events" ADD CONSTRAINT "match_events_match_id_matches_match_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."matches"("match_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_participants" ADD CONSTRAINT "match_participants_match_id_matches_match_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."matches"("match_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "player_patterns" ADD CONSTRAINT "player_patterns_puuid_players_puuid_fk" FOREIGN KEY ("puuid") REFERENCES "public"."players"("puuid") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ranked_stats" ADD CONSTRAINT "ranked_stats_puuid_players_puuid_fk" FOREIGN KEY ("puuid") REFERENCES "public"."players"("puuid") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "timeline_frames" ADD CONSTRAINT "timeline_frames_match_id_matches_match_id_fk" FOREIGN KEY ("match_id") REFERENCES "public"."matches"("match_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "uq_ai_analyses_match_puuid_type" ON "ai_analyses" USING btree ("match_id","puuid","analysis_type");--> statement-breakpoint
CREATE INDEX "idx_ai_analyses_lookup" ON "ai_analyses" USING btree ("match_id","puuid");--> statement-breakpoint
CREATE INDEX "idx_build_stats_champion" ON "build_stats" USING btree ("champion_id","role","patch");--> statement-breakpoint
CREATE INDEX "idx_match_events_match" ON "match_events" USING btree ("match_id");--> statement-breakpoint
CREATE INDEX "idx_match_events_type" ON "match_events" USING btree ("event_type");--> statement-breakpoint
CREATE UNIQUE INDEX "uq_match_participants_match_puuid" ON "match_participants" USING btree ("match_id","puuid");--> statement-breakpoint
CREATE INDEX "idx_match_participants_puuid" ON "match_participants" USING btree ("puuid");--> statement-breakpoint
CREATE INDEX "idx_match_participants_champion" ON "match_participants" USING btree ("champion_name");--> statement-breakpoint
CREATE INDEX "idx_player_patterns_puuid" ON "player_patterns" USING btree ("puuid");--> statement-breakpoint
CREATE INDEX "idx_timeline_frames_match" ON "timeline_frames" USING btree ("match_id");