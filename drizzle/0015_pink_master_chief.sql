ALTER TABLE `memories` ADD `fact_key` text;--> statement-breakpoint
ALTER TABLE `memories` ADD `valid_from` integer DEFAULT (unixepoch() * 1000) NOT NULL;--> statement-breakpoint
ALTER TABLE `memories` ADD `valid_to` integer;--> statement-breakpoint
ALTER TABLE `memories` ADD `superseded_by` text;--> statement-breakpoint
ALTER TABLE `memories` ADD `source_kind` text DEFAULT 'extracted' NOT NULL;--> statement-breakpoint
ALTER TABLE `memories` ADD `revision` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
CREATE INDEX `memories_fact_key_idx` ON `memories` (`profile_id`,`fact_key`,`superseded_by`);