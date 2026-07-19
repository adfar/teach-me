CREATE TABLE `courses` (
	`id` text PRIMARY KEY NOT NULL,
	`topic` text NOT NULL,
	`title` text,
	`description` text,
	`difficulty` text,
	`prerequisites` text,
	`schema_version` integer DEFAULT 1 NOT NULL,
	`status` text NOT NULL,
	`error` text,
	`created_at` integer
);
--> statement-breakpoint
CREATE TABLE `lessons` (
	`id` text PRIMARY KEY NOT NULL,
	`module_id` text NOT NULL,
	`position` integer NOT NULL,
	`title` text NOT NULL,
	`summary` text NOT NULL,
	`status` text NOT NULL,
	`content` text,
	`error` text,
	FOREIGN KEY (`module_id`) REFERENCES `modules`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `modules` (
	`id` text PRIMARY KEY NOT NULL,
	`course_id` text NOT NULL,
	`position` integer NOT NULL,
	`title` text NOT NULL,
	`objective` text NOT NULL,
	FOREIGN KEY (`course_id`) REFERENCES `courses`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `progress` (
	`lesson_id` text PRIMARY KEY NOT NULL,
	`completed_at` integer,
	`quiz_score` integer,
	`quiz_total` integer,
	FOREIGN KEY (`lesson_id`) REFERENCES `lessons`(`id`) ON UPDATE no action ON DELETE cascade
);
