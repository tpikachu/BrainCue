CREATE TABLE `contributions` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`kind` text NOT NULL,
	`status` text DEFAULT 'completed' NOT NULL,
	`title` text,
	`body` text DEFAULT '' NOT NULL,
	`meta` text,
	`source_refs` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `contributions_session_idx` ON `contributions` (`session_id`);