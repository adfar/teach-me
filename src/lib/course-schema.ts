import { z } from "zod";

export const LessonOutlineV1 = z.object({
  title: z.string().min(1),
  summary: z.string().min(1),
});

export const ModuleV1 = z.object({
  title: z.string().min(1),
  objective: z.string().min(1),
  lessons: z.array(LessonOutlineV1).min(2).max(5),
});

export const CourseV1 = z.object({
  schemaVersion: z.literal(1),
  title: z.string().min(1),
  topic: z.string().min(1),
  description: z.string().min(1),
  difficulty: z.enum(["beginner", "intermediate", "advanced"]),
  prerequisites: z.array(z.string()),
  modules: z.array(ModuleV1).min(3).max(6),
});

export const LessonReviewIssueV1 = z.object({
  category: z.enum(["accuracy", "scope", "overlap", "quiz"]),
  severity: z.enum(["minor", "major"]),
  description: z.string(),
});

export const LessonReviewV1 = z.object({
  passed: z.boolean(),
  issues: z.array(LessonReviewIssueV1),
});

export const QuizQuestionV1 = z.object({
  prompt: z.string().min(1),
  choices: z.array(z.string()).length(4),
  correctIndex: z.number().int().min(0).max(3),
  explanations: z.array(z.string()).length(4),
});

const ExplanationBlockV1 = z.object({
  type: z.literal("explanation"),
  markdown: z.string().min(1),
});

const ExampleBlockV1 = z.object({
  type: z.literal("example"),
  title: z.string().min(1),
  markdown: z.string().min(1),
});

const CalloutBlockV1 = z.object({
  type: z.literal("callout"),
  variant: z.enum(["tip", "warning", "analogy"]),
  markdown: z.string().min(1),
});

const QuizBlockV1 = z.object({
  type: z.literal("quiz"),
  questions: z.array(QuizQuestionV1).min(2).max(4),
});

export const LessonBlockV1 = z.discriminatedUnion("type", [
  ExplanationBlockV1,
  ExampleBlockV1,
  CalloutBlockV1,
  QuizBlockV1,
]);

export const LessonContentV1 = z
  .object({
    schemaVersion: z.literal(1),
    blocks: z.array(LessonBlockV1),
  })
  .superRefine((lesson, context) => {
    const explanationCount = lesson.blocks.filter(
      (block) => block.type === "explanation",
    ).length;
    const exampleCount = lesson.blocks.filter(
      (block) => block.type === "example",
    ).length;
    const quizIndexes = lesson.blocks.flatMap((block, index) =>
      block.type === "quiz" ? [index] : [],
    );

    if (explanationCount < 1) {
      context.addIssue({
        code: "custom",
        path: ["blocks"],
        message: "A lesson must contain at least one explanation block.",
      });
    }
    if (exampleCount < 1) {
      context.addIssue({
        code: "custom",
        path: ["blocks"],
        message: "A lesson must contain at least one example block.",
      });
    }
    if (quizIndexes.length !== 1) {
      context.addIssue({
        code: "custom",
        path: ["blocks"],
        message: "A lesson must contain exactly one quiz block.",
      });
    } else if (quizIndexes[0] !== lesson.blocks.length - 1) {
      context.addIssue({
        code: "custom",
        path: ["blocks", quizIndexes[0]],
        message: "The quiz must be the final lesson block.",
      });
    }
  });

export type CourseV1 = z.infer<typeof CourseV1>;
export type ModuleV1 = z.infer<typeof ModuleV1>;
export type LessonOutlineV1 = z.infer<typeof LessonOutlineV1>;
export type LessonReviewIssueV1 = z.infer<typeof LessonReviewIssueV1>;
export type LessonReviewV1 = z.infer<typeof LessonReviewV1>;
export type LessonContentV1 = z.infer<typeof LessonContentV1>;
export type LessonBlockV1 = z.infer<typeof LessonBlockV1>;
export type QuizQuestionV1 = z.infer<typeof QuizQuestionV1>;
