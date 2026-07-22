CREATE TABLE `memories` (
	`id` text PRIMARY KEY NOT NULL,
	`profile_id` text NOT NULL,
	`pack_id` text,
	`category` text NOT NULL,
	`content` text NOT NULL,
	`source_refs` text,
	`confidence` real DEFAULT 0 NOT NULL,
	`importance` real DEFAULT 0.5 NOT NULL,
	`sensitive` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`embed_provider` text,
	`embed_model` text,
	`embed_dim` integer,
	`embed_vector` blob,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`last_used_at` integer,
	`expires_at` integer,
	FOREIGN KEY (`profile_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`pack_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `memories_profile_idx` ON `memories` (`profile_id`);--> statement-breakpoint
CREATE INDEX `memories_status_idx` ON `memories` (`status`);--> statement-breakpoint
ALTER TABLE `jobs` ADD `memory_enabled` integer DEFAULT 1 NOT NULL;