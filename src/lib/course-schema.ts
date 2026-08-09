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
  visualId: z.string().min(1).nullable().optional(),
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

export const IntakeQuestionV1 = z
  .object({
    id: z.string().min(1),
    question: z.string().min(1),
    rationale: z.string().min(1),
    kind: z.enum(["single", "multi", "text"]),
    options: z.array(z.string().min(1)).max(6),
  })
  .superRefine((intakeQuestion, context) => {
    if (intakeQuestion.kind === "text" && intakeQuestion.options.length > 0) {
      context.addIssue({
        code: "custom",
        path: ["options"],
        message: "Text questions must have an empty options array.",
      });
    }
    if (
      intakeQuestion.kind !== "text" &&
      intakeQuestion.options.length === 0
    ) {
      context.addIssue({
        code: "custom",
        path: ["options"],
        message: "Single and multi questions must provide answer options.",
      });
    }
  });

export const IntakeQuestionsV1 = z
  .object({
    schemaVersion: z.literal(1),
    questions: z.array(IntakeQuestionV1).min(4).max(6),
  })
  .superRefine((intakeQuestions, context) => {
    const ids = new Set(intakeQuestions.questions.map(({ id }) => id));
    if (ids.size !== intakeQuestions.questions.length) {
      context.addIssue({
        code: "custom",
        path: ["questions"],
        message: "Intake question ids must be unique.",
      });
    }
  });

export const IntakeMessageV1 = z.object({
  role: z.enum(["assistant", "user"]),
  content: z.string().trim().min(1),
});

export const IntakeConversationV1 = z.object({
  schemaVersion: z.literal(1),
  messages: z.array(IntakeMessageV1).min(1),
});

export const IntakeChatResponseV1 = z
  .object({
    reply: z.string().trim().min(1),
    ready: z.boolean(),
    profile: z
      .object({
        derivedLevel: z.enum(["beginner", "intermediate", "advanced"]),
        goals: z.string().trim().min(1),
        background: z.string().trim().min(1),
      })
      .nullable(),
  })
  .superRefine((response, context) => {
    if (response.ready !== (response.profile !== null)) {
      context.addIssue({
        code: "custom",
        path: ["profile"],
        message: "A completed intake must include a learner profile.",
      });
    }
  });

const LearnerAnswerV1 = z.object({
  questionId: z.string().min(1),
  question: z.string().min(1),
  answer: z.union([z.string(), z.array(z.string().min(1)).min(1)]),
});

export const LearnerProfileV1 = z.object({
  schemaVersion: z.literal(1),
  answers: z.array(LearnerAnswerV1),
  derivedLevel: z.enum(["beginner", "intermediate", "advanced"]),
  goals: z.string().min(1),
  background: z.string().min(1),
});

export const LessonPlanV1 = z.object({
  schemaVersion: z.literal(1),
  estimatedMinutes: z.number().int().min(30).max(75),
  sections: z
    .array(
      z.object({
        heading: z.string().min(1),
        objective: z.string().min(1),
        mustCover: z.array(z.string().min(1)).min(1),
        minutes: z.number().int().min(1),
      }),
    )
    .min(3)
    .max(7),
  keyTermsToIntroduce: z.array(z.string().min(1)).min(3),
});

export const ExerciseBlockV2 = z.object({
  type: z.literal("exercise"),
  visualId: z.string().min(1).nullable().optional(),
  prompt: z.string().min(1),
  hint: z.string().min(1),
  solution: z.string().min(1),
});

// Codex structured outputs accepts `anyOf` but rejects the `oneOf` emitted by
// Zod discriminated unions. The literal `type` fields still provide the same
// runtime discrimination when Zod parses the generated lesson.
export const LessonSectionBlockV2 = z.union([
  ExplanationBlockV1,
  ExampleBlockV1,
  CalloutBlockV1,
  ExerciseBlockV2,
]);

export const LessonSectionV2 = z.object({
  heading: z.string().min(1),
  minutes: z.number().int().min(1),
  blocks: z.array(LessonSectionBlockV2).min(2),
});

const VisualMetadataV4 = {
  type: z.literal("visual"),
  id: z.string().min(1),
  title: z.string().min(1),
  caption: z.string().min(1),
  altText: z.string().min(1),
};

const ChartVisualBlockV4 = z.object({
  ...VisualMetadataV4,
  visual: z.object({
    kind: z.literal("chart"),
    chartType: z.enum(["bar", "line", "scatter"]),
    xLabel: z.string().min(1),
    yLabel: z.string().min(1),
    series: z
      .array(
        z.object({
          name: z.string().min(1),
          points: z
            .array(
              z.object({
                label: z.string().min(1),
                value: z.number(),
              }),
            )
            .min(2)
            .max(12),
        }),
      )
      .min(1)
      .max(4),
  }),
});

const DiagramVisualBlockV4 = z.object({
  ...VisualMetadataV4,
  visual: z.object({
    kind: z.literal("diagram"),
    nodes: z
      .array(
        z.object({
          id: z.string().min(1),
          label: z.string().min(1),
          x: z.number().min(0).max(100),
          y: z.number().min(0).max(100),
        }),
      )
      .min(2)
      .max(12),
    edges: z
      .array(
        z.object({
          from: z.string().min(1),
          to: z.string().min(1),
          label: z.string().nullable().optional(),
        }),
      )
      .max(20),
  }),
});

const MapVisualBlockV4 = z.object({
  ...VisualMetadataV4,
  visual: z.object({
    kind: z.literal("map"),
    scope: z.enum(["world", "united_states"]),
    highlightedRegions: z
      .array(
        z.object({
          name: z.string().min(1),
          label: z.string().nullable().optional(),
        }),
      )
      .max(20),
    markers: z
      .array(
        z.object({
          label: z.string().min(1),
          latitude: z.number().min(-90).max(90),
          longitude: z.number().min(-180).max(180),
        }),
      )
      .max(20),
  }),
});

export const VisualBlockV4 = z.union([
  ChartVisualBlockV4,
  DiagramVisualBlockV4,
  MapVisualBlockV4,
]);

export const LessonSectionBlockV4 = z.union([
  LessonSectionBlockV2,
  VisualBlockV4,
]);

export const LessonSectionV4 = z.object({
  heading: z.string().min(1),
  minutes: z.number().int().min(1),
  blocks: z.array(LessonSectionBlockV4).min(2),
});

const KeyTermV2 = z.object({
  term: z.string().min(1),
  definition: z.string().min(1),
});

export const LessonContentV2 = z.object({
  schemaVersion: z.literal(2),
  estimatedMinutes: z.number().int().min(30).max(75),
  keyTerms: z.array(KeyTermV2).min(3),
  sections: z.array(LessonSectionV2).min(3),
  quiz: z.object({
    questions: z.array(QuizQuestionV1).min(3).max(6),
  }),
});

export const LessonContentV3 = z
  .object({
    schemaVersion: z.literal(3),
    estimatedMinutes: z.number().int().min(20).max(30),
    keyTerms: z.array(KeyTermV2).min(3),
    sections: z.array(LessonSectionV2).min(3).max(4),
    quiz: z.object({
      questions: z.array(QuizQuestionV1).min(3).max(6),
    }),
  })
  .superRefine((lesson, context) => {
    const sectionMinutes = lesson.sections.reduce(
      (total, section) => total + section.minutes,
      0,
    );
    if (sectionMinutes !== lesson.estimatedMinutes) {
      context.addIssue({
        code: "custom",
        path: ["sections"],
        message: "Section minutes must sum to the lesson estimate.",
      });
    }

    lesson.sections.forEach((section, index) => {
      if (!section.blocks.some((block) => block.type === "explanation")) {
        context.addIssue({
          code: "custom",
          path: ["sections", index, "blocks"],
          message: "Each section must include an explanation block.",
        });
      }
    });

    if (
      !lesson.sections.some((section) =>
        section.blocks.some((block) => block.type === "example"),
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["sections"],
        message: "A lesson must include at least one worked example.",
      });
    }
  });

export const LessonContentV4Draft = z.object({
  schemaVersion: z.literal(4),
  estimatedMinutes: z.number().int().min(20).max(30),
  keyTerms: z.array(KeyTermV2).min(3),
  sections: z.array(LessonSectionV4).min(3).max(4),
  quiz: z.object({
    questions: z.array(QuizQuestionV1).min(3).max(6),
  }),
});

export const LessonContentV4 = LessonContentV4Draft
  .superRefine((lesson, context) => {
    const sectionMinutes = lesson.sections.reduce(
      (total, section) => total + section.minutes,
      0,
    );
    if (sectionMinutes !== lesson.estimatedMinutes) {
      context.addIssue({
        code: "custom",
        path: ["sections"],
        message: "Section minutes must sum to the lesson estimate.",
      });
    }

    lesson.sections.forEach((section, index) => {
      if (!section.blocks.some((block) => block.type === "explanation")) {
        context.addIssue({
          code: "custom",
          path: ["sections", index, "blocks"],
          message: "Each section must include an explanation block.",
        });
      }
    });

    if (
      !lesson.sections.some((section) =>
        section.blocks.some((block) => block.type === "example"),
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["sections"],
        message: "A lesson must include at least one worked example.",
      });
    }

    const visualIds = lesson.sections.flatMap((section) =>
      section.blocks.flatMap((block) =>
        block.type === "visual" ? [block.id] : [],
      ),
    );
    if (new Set(visualIds).size !== visualIds.length) {
      context.addIssue({
        code: "custom",
        path: ["sections"],
        message: "Visual ids must be unique within a lesson.",
      });
    }

    const referencedVisualIds = [
      ...lesson.sections.flatMap((section) =>
        section.blocks.flatMap((block) =>
          block.type === "exercise" && block.visualId
            ? [block.visualId]
            : [],
        ),
      ),
      ...lesson.quiz.questions.flatMap((question) =>
        question.visualId ? [question.visualId] : [],
      ),
    ];
    referencedVisualIds.forEach((visualId) => {
      if (!visualIds.includes(visualId)) {
        context.addIssue({
          code: "custom",
          path: ["sections"],
          message: `Visual reference ${visualId} does not match a visual block.`,
        });
      }
    });
  });

export const LessonContentStructured = z.union([
  LessonContentV2,
  LessonContentV3,
  LessonContentV4,
]);
export const LessonContentAny = z.union([
  LessonContentV1,
  LessonContentV2,
  LessonContentV3,
  LessonContentV4,
]);

export type CourseV1 = z.infer<typeof CourseV1>;
export type ModuleV1 = z.infer<typeof ModuleV1>;
export type LessonOutlineV1 = z.infer<typeof LessonOutlineV1>;
export type LessonReviewIssueV1 = z.infer<typeof LessonReviewIssueV1>;
export type LessonReviewV1 = z.infer<typeof LessonReviewV1>;
export type LessonContentV1 = z.infer<typeof LessonContentV1>;
export type LessonBlockV1 = z.infer<typeof LessonBlockV1>;
export type QuizQuestionV1 = z.infer<typeof QuizQuestionV1>;
export type IntakeQuestionV1 = z.infer<typeof IntakeQuestionV1>;
export type IntakeQuestionsV1 = z.infer<typeof IntakeQuestionsV1>;
export type IntakeMessageV1 = z.infer<typeof IntakeMessageV1>;
export type IntakeConversationV1 = z.infer<typeof IntakeConversationV1>;
export type IntakeChatResponseV1 = z.infer<typeof IntakeChatResponseV1>;
export type LearnerProfileV1 = z.infer<typeof LearnerProfileV1>;
export type LessonPlanV1 = z.infer<typeof LessonPlanV1>;
export type ExerciseBlockV2 = z.infer<typeof ExerciseBlockV2>;
export type LessonSectionBlockV2 = z.infer<typeof LessonSectionBlockV2>;
export type LessonSectionV2 = z.infer<typeof LessonSectionV2>;
export type VisualBlockV4 = z.infer<typeof VisualBlockV4>;
export type LessonSectionBlockV4 = z.infer<typeof LessonSectionBlockV4>;
export type LessonSectionV4 = z.infer<typeof LessonSectionV4>;
export type LessonContentV2 = z.infer<typeof LessonContentV2>;
export type LessonContentV3 = z.infer<typeof LessonContentV3>;
export type LessonContentV4Draft = z.infer<typeof LessonContentV4Draft>;
export type LessonContentV4 = z.infer<typeof LessonContentV4>;
export type LessonContentStructured = z.infer<typeof LessonContentStructured>;
export type LessonContentAny = z.infer<typeof LessonContentAny>;
