CREATE TABLE `applications` (
	`id` text PRIMARY KEY NOT NULL,
	`profile_id` text NOT NULL,
	`job_id` text NOT NULL,
	`name` text DEFAULT '' NOT NULL,
	`job_title` text DEFAULT '' NOT NULL,
	`company` text,
	`base_resume` text NOT NULL,
	`tailored_resume` text NOT NULL,
	`answers` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`profile_id`) REFERENCES `profiles`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `applications_profile_idx` ON `applications` (`profile_id`);--> statement-breakpoint
CREATE INDEX `applications_created_idx` ON `applications` (`created_at`);