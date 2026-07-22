ALTER TABLE `jobs` ADD `kind` text DEFAULT 'job' NOT NULL;--> statement-breakpoint
ALTER TABLE `sessions` ADD `mode` text DEFAULT 'interview' NOT NULL;--> statement-breakpoint
ALTER TABLE `profiles` DROP COLUMN `answer_style`;--> statement-breakpoint
-- v2 backfill: sessions get their SessionMode from the legacy kind
-- (live -> interview; mock/sparring -> practice). New rows use the column default.
UPDATE `sessions` SET `mode` = CASE WHEN `kind` = 'live' THEN 'interview' ELSE 'practice' END;
