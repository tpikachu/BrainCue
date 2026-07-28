CREATE TABLE `entities` (
	`id` text PRIMARY KEY NOT NULL,
	`profile_id` text NOT NULL,
	`kind` text NOT NULL,
	`canonical_name` text NOT NULL,
	`aliases` text,
	`summary` text,
	`importance` real DEFAULT 0.5 NOT NULL,
	`first_seen_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`last_seen_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`merged_into` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`profile_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `entities_profile_idx` ON `entities` (`profile_id`);--> statement-breakpoint
CREATE INDEX `entities_name_idx` ON `entities` (`profile_id`,`canonical_name`);--> statement-breakpoint
CREATE TABLE `memory_entities` (
	`memory_id` text NOT NULL,
	`entity_id` text NOT NULL,
	`role` text DEFAULT 'mentioned' NOT NULL,
	FOREIGN KEY (`memory_id`) REFERENCES `memories`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`entity_id`) REFERENCES `entities`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `memory_entities_memory_idx` ON `memory_entities` (`memory_id`);--> statement-breakpoint
CREATE INDEX `memory_entities_entity_idx` ON `memory_entities` (`entity_id`);