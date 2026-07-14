CREATE TABLE `answer_feedback` (
	`id` text PRIMARY KEY NOT NULL,
	`session_id` text NOT NULL,
	`question_id` text NOT NULL,
	`answer_transcript` text DEFAULT '' NOT NULL,
	`rating` integer DEFAULT 0 NOT NULL,
	`verdict` text DEFAULT '' NOT NULL,
	`strengths` text,
	`improvements` text,
	`tip` text,
	`competency` text,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`question_id`) REFERENCES `detected_questions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `answer_feedback_session_idx` ON `answer_feedback` (`session_id`);--> statement-breakpoint
ALTER TABLE `sessions` ADD `kind` text DEFAULT 'live' NOT NULL;--> statement-breakpoint
ALTER TABLE `ai_answers` DROP COLUMN `talking_points`;--> statement-breakpoint
ALTER TABLE `ai_answers` DROP COLUMN `resume_match`;--> statement-breakpoint
ALTER TABLE `ai_answers` DROP COLUMN `star`;--> statement-breakpoint
ALTER TABLE `ai_answers` DROP COLUMN `clarifying_question`;