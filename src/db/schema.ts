import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const courses = sqliteTable("courses", {
  id: text("id").primaryKey(),
  topic: text("topic").notNull(),
  title: text("title"),
  description: text("description"),
  difficulty: text("difficulty"),
  prerequisites: text("prerequisites"),
  schemaVersion: integer("schema_version").notNull().default(1),
  status: text("status").notNull(),
  error: text("error"),
  learnerProfile: text("learner_profile"),
  intakeQuestions: text("intake_questions"),
  intakeConversation: text("intake_conversation"),
  outlineApprovedAt: integer("outline_approved_at"),
  createdAt: integer("created_at"),
});

export const modules = sqliteTable("modules", {
  id: text("id").primaryKey(),
  courseId: text("course_id")
    .notNull()
    .references(() => courses.id, { onDelete: "cascade" }),
  position: integer("position").notNull(),
  title: text("title").notNull(),
  objective: text("objective").notNull(),
});

export const lessons = sqliteTable("lessons", {
  id: text("id").primaryKey(),
  moduleId: text("module_id")
    .notNull()
    .references(() => modules.id, { onDelete: "cascade" }),
  position: integer("position").notNull(),
  title: text("title").notNull(),
  summary: text("summary").notNull(),
  status: text("status").notNull(),
  generationStartedAt: integer("generation_started_at"),
  content: text("content"),
  error: text("error"),
  reviewStatus: text("review_status", { enum: ["passed", "flagged"] }),
  reviewNotes: text("review_notes"),
  conceptsTaught: text("concepts_taught"),
  plan: text("plan"),
  estimatedMinutes: integer("estimated_minutes"),
});

export const progress = sqliteTable("progress", {
  lessonId: text("lesson_id")
    .primaryKey()
    .references(() => lessons.id, { onDelete: "cascade" }),
  completedAt: integer("completed_at"),
  quizScore: integer("quiz_score"),
  quizTotal: integer("quiz_total"),
});
