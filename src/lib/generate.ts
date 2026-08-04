import "server-only";

import { and, asc, eq, inArray, isNull, lt, or } from "drizzle-orm";
import { db } from "@/db";
import { courses, lessons, modules } from "@/db/schema";
import {
  CourseV1,
  IntakeQuestionsV1,
  LearnerProfileV1,
  LessonContentV2,
  LessonPlanV1,
  LessonReviewV1,
  LessonSectionV2,
  type CourseV1 as Course,
  type IntakeQuestionsV1 as IntakeQuestions,
  type LearnerProfileV1 as LearnerProfile,
  type LessonContentV2 as LessonContent,
  type LessonPlanV1 as LessonPlan,
  type LessonReviewIssueV1 as LessonReviewIssue,
  type LessonReviewV1 as LessonReview,
  type LessonSectionV2 as LessonSection,
} from "@/lib/course-schema";
import { generateStructured } from "@/lib/llm";

const MODEL = process.env.GENERATION_MODEL ?? "claude-opus-5";
const REVIEW_BACKEND = (process.env.REVIEW_BACKEND ?? "api") as
  | "api"
  | "subscription"
  | "codex";
const REVIEW_MODEL =
  process.env.REVIEW_MODEL ??
  (REVIEW_BACKEND === "codex" ? "gpt-5.6-sol" : "claude-sonnet-5");
const MAX_TOKENS = 16_000;
const DEFAULT_LESSON_GENERATION_STALE_MS = 15 * 60 * 1_000;

export function lessonGenerationStaleMilliseconds(): number {
  const value = process.env.LESSON_GENERATION_STALE_MS;
  if (value === undefined) return DEFAULT_LESSON_GENERATION_STALE_MS;

  const milliseconds = Number(value);
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) {
    throw new Error(
      "LESSON_GENERATION_STALE_MS must be a positive number of milliseconds.",
    );
  }
  return milliseconds;
}

export function lessonGenerationStaleBefore(now = Date.now()): number {
  return now - lessonGenerationStaleMilliseconds();
}

function staleLessonGeneration(staleBefore: number) {
  return and(
    eq(lessons.status, "generating"),
    or(
      isNull(lessons.generationStartedAt),
      lt(lessons.generationStartedAt, staleBefore),
    ),
  );
}

const GeneratedSectionBlocksV2 = LessonSectionV2.pick({
  blocks: true,
}).superRefine((section, context) => {
  if (!section.blocks.some((block) => block.type === "explanation")) {
    context.addIssue({
      code: "custom",
      path: ["blocks"],
      message: "A section must contain an explanation block.",
    });
  }
  if (!section.blocks.some((block) => block.type === "example")) {
    context.addIssue({
      code: "custom",
      path: ["blocks"],
      message: "A section must contain a worked example block.",
    });
  }
});

const LessonFinishV2 = LessonContentV2.pick({
  keyTerms: true,
  quiz: true,
});

type LearnerAnswers = LearnerProfile["answers"];

type ConceptLedgerEntry = {
  lesson: string;
  keyTerms: string[];
  sectionHeadings: string[];
};

function errorMessage(error: unknown): string {
  return error instanceof Error
    ? error.message
    : "An unknown generation error occurred.";
}

async function requestIntakeQuestions(topic: string): Promise<IntakeQuestions> {
  const generated = await generateStructured({
    model: MODEL,
    system:
      "You design concise learner-intake interviews. Ask only questions whose answers will materially change a course outline or the depth, examples, exercises, and pacing of its lessons.",
    prompt: `Create the intake interview for a course about ${JSON.stringify(topic)}.

Requirements:
- Use schemaVersion 1 and create 4–6 questions with stable, descriptive ids.
- Collect all five of these signals: what the learner wants to be able to DO after the course; their current background and adjacent knowledge; their specific prior exposure to this exact topic; their available time budget per lesson; and how theoretical versus applied they want the teaching to be.
- Combine signals in one question only when the result remains easy to answer.
- Use single or multi choice when a short set of choices will produce cleaner information, with no more than 6 options.
- Use text when individual detail matters, and always return an empty options array for text questions.
- Explain in one sentence in rationale how each answer will affect course design.
- Do not ask for information that does not change the course.`,
    schema: IntakeQuestionsV1,
    maxTokens: MAX_TOKENS,
  });

  return IntakeQuestionsV1.parse(generated);
}

async function createIntakeCourse(topic: string): Promise<{
  courseId: string;
  intakeQuestions: IntakeQuestions;
}> {
  const intakeQuestions = await requestIntakeQuestions(topic);
  const courseId = crypto.randomUUID();

  db.insert(courses)
    .values({
      id: courseId,
      topic,
      schemaVersion: 1,
      status: "intake",
      intakeQuestions: JSON.stringify(intakeQuestions),
      createdAt: Date.now(),
    })
    .run();

  return { courseId, intakeQuestions };
}

export async function startCourseIntake(topic: string): Promise<{
  courseId: string;
  intakeQuestions: IntakeQuestions;
}> {
  return createIntakeCourse(topic);
}

export async function generateIntakeQuestions(
  topic: string,
): Promise<IntakeQuestions> {
  const { intakeQuestions } = await createIntakeCourse(topic);
  return intakeQuestions;
}

async function requestLearnerProfile(
  topic: string,
  answers: LearnerAnswers,
): Promise<LearnerProfile> {
  const generated = await generateStructured({
    model: MODEL,
    system:
      "You synthesize learner intake answers into a faithful, practical teaching profile. Infer conservatively: never invent experience or knowledge the learner did not state.",
    prompt: `Synthesize a learner profile for a course about ${JSON.stringify(topic)}.

Raw intake answers:
${JSON.stringify(answers, null, 2)}

Requirements:
- Use schemaVersion 1 and reproduce the raw answers exactly.
- Set derivedLevel to beginner, intermediate, or advanced based on demonstrated topic-specific knowledge, not confidence or ambition.
- Summarize in goals the concrete capability the learner wants and their preferred balance of theory and application.
- Summarize in background only the knowledge and experience they explicitly reported, including relevant adjacent knowledge and exact-topic exposure.
- Include the learner's lesson time budget in goals so downstream planning can respect it.
- If information is missing, say so plainly instead of guessing.`,
    schema: LearnerProfileV1,
    maxTokens: MAX_TOKENS,
  });

  return LearnerProfileV1.parse({ ...generated, answers });
}

function normalizeIntakeAnswers(
  intakeQuestions: IntakeQuestions,
  answers: LearnerAnswers,
): LearnerAnswers {
  const parsed = LearnerProfileV1.shape.answers.parse(answers);
  const byQuestionId = new Map(parsed.map((answer) => [answer.questionId, answer]));

  if (
    byQuestionId.size !== parsed.length ||
    parsed.length !== intakeQuestions.questions.length
  ) {
    throw new Error("Submit exactly one answer for every intake question.");
  }

  return intakeQuestions.questions.map((intakeQuestion) => {
    const supplied = byQuestionId.get(intakeQuestion.id);
    if (!supplied) {
      throw new Error(`Missing answer for intake question ${intakeQuestion.id}.`);
    }

    if (intakeQuestion.kind === "multi") {
      if (!Array.isArray(supplied.answer)) {
        throw new Error(`Question ${intakeQuestion.id} requires multiple choices.`);
      }
      if (
        supplied.answer.some(
          (choice) => !intakeQuestion.options.includes(choice),
        )
      ) {
        throw new Error(`Question ${intakeQuestion.id} has an invalid choice.`);
      }
    } else if (Array.isArray(supplied.answer)) {
      throw new Error(`Question ${intakeQuestion.id} requires one text answer.`);
    } else if (
      intakeQuestion.kind === "single" &&
      !intakeQuestion.options.includes(supplied.answer)
    ) {
      throw new Error(`Question ${intakeQuestion.id} has an invalid choice.`);
    }

    return {
      questionId: intakeQuestion.id,
      question: intakeQuestion.question,
      answer: supplied.answer,
    };
  });
}

async function requestOutline(
  topic: string,
  learnerProfile: LearnerProfile,
  feedback = "",
): Promise<Course> {
  const feedbackInstructions = feedback.trim()
    ? `\n\nThe learner rejected the previous outline and gave this feedback:\n${JSON.stringify(feedback.trim())}\nRevise the course design to address every actionable point without contradicting the learner profile.`
    : "";

  const generated = await generateStructured({
    model: MODEL,
    system:
      "You design focused, coherent courses. Order concepts by their dependencies, scope every lesson for deep study, and adapt the course to the learner rather than producing a generic table of contents.",
    prompt: `Create a complete course outline for this request: ${JSON.stringify(topic)}.

Learner profile:
${JSON.stringify(learnerProfile, null, 2)}

Requirements:
- Preserve the user's request exactly in the topic field and use schemaVersion 1.
- Condition the difficulty, prerequisites, sequencing, examples, and scope on the learner profile.
- Write a 2–3 sentence description.
- Create 3–6 modules in dependency order and 2–5 lessons per module.
- Give every module a concrete learning objective.
- Scope every lesson for 30–60 minutes of genuine study. Give it a 1–2 sentence summary stating exactly what it will teach.
- Prefer fewer ideas taught thoroughly over broad survey coverage.
- Avoid overlap between lessons and avoid assigning a lesson concepts that depend on later lessons.
- Keep the course focused on the concrete capability in the learner's goals.${feedbackInstructions}`,
    schema: CourseV1,
    maxTokens: MAX_TOKENS,
  });

  return CourseV1.parse({ ...generated, topic });
}

function replaceCourseOutline(
  courseId: string,
  outline: Course,
  status: "outline_review",
) {
  db.transaction((transaction) => {
    transaction.delete(modules).where(eq(modules.courseId, courseId)).run();
    transaction
      .update(courses)
      .set({
        title: outline.title,
        description: outline.description,
        difficulty: outline.difficulty,
        prerequisites: JSON.stringify(outline.prerequisites),
        schemaVersion: 1,
        status,
        error: null,
        outlineApprovedAt: null,
      })
      .where(eq(courses.id, courseId))
      .run();

    outline.modules.forEach((courseModule, modulePosition) => {
      const moduleId = crypto.randomUUID();
      transaction
        .insert(modules)
        .values({
          id: moduleId,
          courseId,
          position: modulePosition,
          title: courseModule.title,
          objective: courseModule.objective,
        })
        .run();

      courseModule.lessons.forEach((lesson, lessonPosition) => {
        transaction
          .insert(lessons)
          .values({
            id: crypto.randomUUID(),
            moduleId,
            position: lessonPosition,
            title: lesson.title,
            summary: lesson.summary,
            status: "pending",
          })
          .run();
      });
    });
  });
}

export async function submitIntakeAnswers(
  courseId: string,
  answers: LearnerAnswers,
): Promise<void> {
  const course = await db.query.courses.findFirst({
    where: eq(courses.id, courseId),
  });
  if (!course) throw new Error("Course not found.");
  if (!course.intakeQuestions) {
    throw new Error("This course does not have intake questions.");
  }

  const intakeQuestions = IntakeQuestionsV1.parse(
    JSON.parse(course.intakeQuestions),
  );
  const normalizedAnswers = normalizeIntakeAnswers(intakeQuestions, answers);
  const learnerProfile = await requestLearnerProfile(
    course.topic,
    normalizedAnswers,
  );

  db.update(courses)
    .set({
      learnerProfile: JSON.stringify(learnerProfile),
      status: "outlining",
      error: null,
    })
    .where(eq(courses.id, courseId))
    .run();

  try {
    const outline = await requestOutline(course.topic, learnerProfile);
    replaceCourseOutline(courseId, outline, "outline_review");
  } catch (error) {
    db.update(courses)
      .set({ status: "failed", error: errorMessage(error) })
      .where(eq(courses.id, courseId))
      .run();
    throw error;
  }
}

export async function regenerateOutline(
  courseId: string,
  feedback: string,
): Promise<void> {
  if (!feedback.trim()) throw new Error("Outline feedback cannot be empty.");

  const course = await db.query.courses.findFirst({
    where: eq(courses.id, courseId),
  });
  if (!course) throw new Error("Course not found.");
  if (!course.learnerProfile) {
    throw new Error("Complete learner intake before regenerating the outline.");
  }
  const learnerProfile = LearnerProfileV1.parse(
    JSON.parse(course.learnerProfile),
  );
  const outline = await requestOutline(
    course.topic,
    learnerProfile,
    feedback,
  );
  replaceCourseOutline(courseId, outline, "outline_review");
}

async function loadGenerationContext(courseId: string) {
  const course = await db.query.courses.findFirst({
    where: eq(courses.id, courseId),
  });
  if (!course) throw new Error("Course not found.");

  const moduleRows = await db
    .select()
    .from(modules)
    .where(eq(modules.courseId, courseId))
    .orderBy(asc(modules.position));
  const moduleIds = moduleRows.map((courseModule) => courseModule.id);
  const lessonRows = moduleIds.length
    ? await db
        .select()
        .from(lessons)
        .where(inArray(lessons.moduleId, moduleIds))
        .orderBy(asc(lessons.position))
    : [];

  const outline = CourseV1.parse({
    schemaVersion: course.schemaVersion,
    title: course.title,
    topic: course.topic,
    description: course.description,
    difficulty: course.difficulty,
    prerequisites: JSON.parse(course.prerequisites ?? "[]"),
    modules: moduleRows.map((courseModule) => ({
      title: courseModule.title,
      objective: courseModule.objective,
      lessons: lessonRows
        .filter((lesson) => lesson.moduleId === courseModule.id)
        .sort((left, right) => left.position - right.position)
        .map((lesson) => ({ title: lesson.title, summary: lesson.summary })),
    })),
  });

  return { course, outline, moduleRows, lessonRows };
}

function learnerProfileForGeneration(
  course: typeof courses.$inferSelect,
): LearnerProfile {
  if (course.learnerProfile) {
    return LearnerProfileV1.parse(JSON.parse(course.learnerProfile));
  }

  const derivedLevel = LearnerProfileV1.shape.derivedLevel.parse(
    course.difficulty ?? "beginner",
  );
  const prerequisites = JSON.parse(course.prerequisites ?? "[]") as unknown;
  const prerequisiteList = Array.isArray(prerequisites)
    ? prerequisites.filter((item): item is string => typeof item === "string")
    : [];

  return LearnerProfileV1.parse({
    schemaVersion: 1,
    answers: [],
    derivedLevel,
    goals: `Learn ${course.topic}. No interactive intake was stored for this archived course.`,
    background: prerequisiteList.length
      ? `The archived course lists these prerequisites: ${prerequisiteList.join(", ")}.`
      : "No learner background was stored for this archived course.",
  });
}

function orderedLessons(
  moduleRows: Array<typeof modules.$inferSelect>,
  lessonRows: Array<typeof lessons.$inferSelect>,
) {
  return moduleRows.flatMap((courseModule) =>
    lessonRows
      .filter((lesson) => lesson.moduleId === courseModule.id)
      .sort((left, right) => left.position - right.position),
  );
}

function conceptLedgerForLesson(
  lessonId: string,
  moduleRows: Array<typeof modules.$inferSelect>,
  lessonRows: Array<typeof lessons.$inferSelect>,
): ConceptLedgerEntry[] {
  const ordered = orderedLessons(moduleRows, lessonRows);
  const targetIndex = ordered.findIndex((lesson) => lesson.id === lessonId);
  if (targetIndex < 0) throw new Error("Lesson not found in this course.");

  return ordered.slice(0, targetIndex).flatMap((lesson) => {
    if (lesson.status !== "ready" || !lesson.content) return [];
    const parsed = LessonContentV2.safeParse(JSON.parse(lesson.content));
    if (!parsed.success) return [];
    return [
      {
        lesson: lesson.title,
        keyTerms: parsed.data.keyTerms.map(({ term }) => term),
        sectionHeadings: parsed.data.sections.map(({ heading }) => heading),
      },
    ];
  });
}

function reviewFixInstructions(issuesToFix: LessonReviewIssue[]): string {
  if (issuesToFix.length === 0) return "";
  return `

This lesson is being regenerated because a prior quality review found these specific issues:
${JSON.stringify(issuesToFix, null, 2)}

Correct every listed issue while continuing to meet all lesson requirements.`;
}

async function requestLessonPlan({
  outline,
  learnerProfile,
  conceptLedger,
  targetModule,
  targetLesson,
  issuesToFix,
}: {
  outline: Course;
  learnerProfile: LearnerProfile;
  conceptLedger: ConceptLedgerEntry[];
  targetModule: { title: string; objective: string };
  targetLesson: { title: string; summary: string };
  issuesToFix: LessonReviewIssue[];
}): Promise<LessonPlan> {
  const generated = await generateStructured({
    model: MODEL,
    system:
      "You plan one rigorous lesson at a time. Plan for genuine study time, explicit prerequisite handling, and deep understanding rather than name-dropping or survey-style breadth.",
    prompt: `Plan the full lesson described below.

Course outline:
${JSON.stringify(outline, null, 2)}

Learner profile:
${JSON.stringify(learnerProfile, null, 2)}

Concept ledger from earlier ready V2 lessons:
${JSON.stringify(conceptLedger, null, 2)}

Target module:
${JSON.stringify(targetModule, null, 2)}

Target lesson:
${JSON.stringify(targetLesson, null, 2)}

Planning requirements:
- Use schemaVersion 1. Target 30–60 minutes of real study and divide that budget among 3–7 coherent sections whose minutes sum to estimatedMinutes.
- Assume the learner knows ONLY what their profile states plus the concepts in the ledger. Do not silently assume any other background.
- Every technical term, proper noun, notation, or named concept not already in the ledger must be introduced and defined in plain language before its first use in an argument. Put every such term in keyTermsToIntroduce.
- Do not forward-reference or teach material assigned to later lessons in the course outline.
- Plan each section to motivate its idea, explain it carefully, and include at least one fully worked example showing every intermediate step. No “it follows that” jumps.
- Most sections must include a worthwhile exercise with a hint and a complete worked solution.
- Depth beats breadth: three ideas taught thoroughly beat eight ideas taught superficially.
- Fill every section's minutes with substantive teaching, examples, and practice—never filler, restatement, or padding.
- Make mustCover concrete enough that a section writer cannot substitute vague overview prose.${reviewFixInstructions(issuesToFix)}`,
    schema: LessonPlanV1,
    maxTokens: MAX_TOKENS,
  });

  return LessonPlanV1.parse(generated);
}

function blockText(block: LessonSection["blocks"][number]): string {
  if (block.type === "explanation") return block.markdown;
  if (block.type === "example") {
    return `Worked example: ${block.title}\n${block.markdown}`;
  }
  if (block.type === "callout") {
    return `${block.variant}: ${block.markdown}`;
  }
  return `Exercise:\n${block.prompt}\nHint:\n${block.hint}\nSolution:\n${block.solution}`;
}

function fullSectionText(sections: LessonSection[]): string {
  if (sections.length === 0) return "No sections have been written yet.";
  return sections
    .map(
      (section) =>
        `# ${section.heading}\n\n${section.blocks.map(blockText).join("\n\n")}`,
    )
    .join("\n\n");
}

async function requestLessonSection({
  outline,
  learnerProfile,
  conceptLedger,
  plan,
  plannedSection,
  completedSections,
  targetModule,
  targetLesson,
  issuesToFix,
}: {
  outline: Course;
  learnerProfile: LearnerProfile;
  conceptLedger: ConceptLedgerEntry[];
  plan: LessonPlan;
  plannedSection: LessonPlan["sections"][number];
  completedSections: LessonSection[];
  targetModule: { title: string; objective: string };
  targetLesson: { title: string; summary: string };
  issuesToFix: LessonReviewIssue[];
}): Promise<LessonSection> {
  const generated = await generateStructured({
    model: MODEL,
    system:
      "You are an expert teacher writing one substantial section of a longer lesson. Teach patiently from the learner's actual knowledge boundary, with precise definitions, causal explanations, fully worked examples, and useful practice.",
    prompt: `Write the blocks for exactly one planned lesson section.

Course outline:
${JSON.stringify(outline, null, 2)}

Learner profile:
${JSON.stringify(learnerProfile, null, 2)}

Concept ledger from earlier ready V2 lessons:
${JSON.stringify(conceptLedger, null, 2)}

Target module and lesson:
${JSON.stringify({ targetModule, targetLesson }, null, 2)}

Full lesson plan:
${JSON.stringify(plan, null, 2)}

Section to write now:
${JSON.stringify(plannedSection, null, 2)}

Full text of sections already generated for this lesson:
${fullSectionText(completedSections)}

Writing requirements:
- Return only the blocks for the named section. Write all prose in Markdown.
- Assume the learner knows ONLY what their profile states plus concepts in the ledger and material already explained in this lesson. Explain everything else from scratch at first use.
- Define every new technical term, proper noun, notation, or named concept in plain language before using it in an argument. Never substitute a name for an explanation.
- Stay inside this section's objective and mustCover list. Do not forward-reference or teach material assigned to later lessons.
- First motivate the idea, then explain it step by step, then give at least one fully worked example block. Show every intermediate step and explain why it is valid; never say “it follows that” to skip reasoning.
- Include an exercise block unless this section is genuinely unsuitable for practice. Across the lesson, most sections must have exercises. Every exercise needs a useful hint and a complete solution that shows the reasoning.
- Use callouts sparingly and only for a genuine warning, tip, or clarifying analogy.
- Write enough substantive explanation, examples, and practice to occupy the planned ${plannedSection.minutes} minutes. Never pad with filler, restatement, generic encouragement, or repeated summaries.
- Depth beats breadth. Teach a few ideas until the learner can use them.${reviewFixInstructions(issuesToFix)}`,
    schema: GeneratedSectionBlocksV2,
    maxTokens: MAX_TOKENS,
  });
  const { blocks } = GeneratedSectionBlocksV2.parse(generated);
  return LessonSectionV2.parse({
    heading: plannedSection.heading,
    minutes: plannedSection.minutes,
    blocks,
  });
}

async function requestLessonFinish({
  outline,
  learnerProfile,
  conceptLedger,
  plan,
  targetLesson,
  sections,
}: {
  outline: Course;
  learnerProfile: LearnerProfile;
  conceptLedger: ConceptLedgerEntry[];
  plan: LessonPlan;
  targetLesson: { title: string; summary: string };
  sections: LessonSection[];
}) {
  const generated = await generateStructured({
    model: MODEL,
    system:
      "You create faithful lesson glossaries and rigorous final quizzes from supplied teaching material. Assess understanding and application, not trivia or wording recall.",
    prompt: `Create the key-term glossary and final quiz for this assembled lesson.

Course outline:
${JSON.stringify(outline, null, 2)}

Learner profile:
${JSON.stringify(learnerProfile, null, 2)}

Concept ledger from earlier ready V2 lessons:
${JSON.stringify(conceptLedger, null, 2)}

Target lesson:
${JSON.stringify(targetLesson, null, 2)}

Full lesson plan:
${JSON.stringify(plan, null, 2)}

Assembled lesson sections:
${fullSectionText(sections)}

Requirements:
- Define at least 3 important terms introduced by this lesson in concise plain language. Include the plan's keyTermsToIntroduce and do not list terms that appear only in later lessons.
- Write 3–6 quiz questions spanning the lesson's important objectives.
- Test whether the learner can explain or apply what the sections taught. Do not test facts absent from the assembled sections.
- Every question must have exactly 4 plausible choices and one correctIndex from 0–3.
- Supply exactly 4 per-choice explanations for each question, aligned by index, explaining specifically why that choice is right or wrong.
- Avoid trick wording, trivia, and choices distinguishable by superficial cues.`,
    schema: LessonFinishV2,
    maxTokens: MAX_TOKENS,
  });

  return LessonFinishV2.parse(generated);
}

async function reviewLesson({
  outline,
  targetLesson,
  content,
}: {
  outline: Course;
  targetLesson: { title: string; summary: string };
  content: LessonContent;
}): Promise<LessonReview> {
  const review = await generateStructured({
    model: REVIEW_MODEL,
    system:
      "You are a meticulous course quality reviewer. Evaluate the supplied lesson independently and report only specific, actionable content problems. This review is advisory; do not rewrite the lesson.",
    prompt: `Review this generated lesson in the context of its assigned course outline.

Course and outline context:
${JSON.stringify(
  {
    courseTitle: outline.title,
    courseDescription: outline.description,
    outline: outline.modules.map((courseModule) => ({
      title: courseModule.title,
      lessons: courseModule.lessons.map((lesson) => ({
        title: lesson.title,
        summary: lesson.summary,
      })),
    })),
    targetLesson,
  },
  null,
  2,
)}

Lesson content:
${JSON.stringify(content, null, 2)}

Check all of the following:
- Factual accuracy of claims in every explanation and worked example.
- Whether the lesson stays within its assigned title and summary.
- Whether it substantially teaches material owned by another lesson in the outline.
- Whether every quiz correctIndex points to the actually correct choice.
- Whether all four per-choice explanations for every quiz question truthfully explain why the corresponding choice is right or wrong.

List every specific issue you find. Use severity "major" when the problem could materially misteach or misassess the learner; otherwise use "minor" for advisory improvements. Return passed=false only when there is at least one major issue. Minor issues may be present when passed=true.`,
    schema: LessonReviewV1,
    maxTokens: MAX_TOKENS,
    backend: REVIEW_BACKEND,
  });

  return LessonReviewV1.parse(review);
}

async function generateClaimedLesson(
  courseId: string,
  lessonId: string,
  issuesToFix: LessonReviewIssue[] = [],
): Promise<boolean> {
  try {
    const { course, outline, moduleRows, lessonRows } =
      await loadGenerationContext(courseId);
    const target = lessonRows.find((lesson) => lesson.id === lessonId);
    if (!target) throw new Error("Lesson not found in this course.");
    const targetModule = moduleRows.find(
      (courseModule) => courseModule.id === target.moduleId,
    );
    if (!targetModule) throw new Error("Lesson module not found.");

    const learnerProfile = learnerProfileForGeneration(course);
    const conceptLedger = conceptLedgerForLesson(
      lessonId,
      moduleRows,
      lessonRows,
    );
    const targetLesson = { title: target.title, summary: target.summary };
    const moduleContext = {
      title: targetModule.title,
      objective: targetModule.objective,
    };
    const plan = await requestLessonPlan({
      outline,
      learnerProfile,
      conceptLedger,
      targetModule: moduleContext,
      targetLesson,
      issuesToFix,
    });

    const sections: LessonSection[] = [];
    for (const plannedSection of plan.sections) {
      sections.push(
        await requestLessonSection({
          outline,
          learnerProfile,
          conceptLedger,
          plan,
          plannedSection,
          completedSections: sections,
          targetModule: moduleContext,
          targetLesson,
          issuesToFix,
        }),
      );
    }

    const finish = await requestLessonFinish({
      outline,
      learnerProfile,
      conceptLedger,
      plan,
      targetLesson,
      sections,
    });
    const validated = LessonContentV2.parse({
      schemaVersion: 2,
      estimatedMinutes: plan.estimatedMinutes,
      keyTerms: finish.keyTerms,
      sections,
      quiz: finish.quiz,
    });

    let reviewStatus: "passed" | "flagged" | null = null;
    let reviewNotes: string | null = null;
    try {
      const review = await reviewLesson({
        outline,
        targetLesson,
        content: validated,
      });
      reviewStatus = review.issues.some((issue) => issue.severity === "major")
        ? "flagged"
        : "passed";
      reviewNotes = review.issues.length
        ? JSON.stringify(review.issues)
        : null;
    } catch (reviewError) {
      console.warn(
        `Quality review skipped for lesson ${lessonId}: ${errorMessage(reviewError)}`,
      );
    }

    db.update(lessons)
      .set({
        status: "ready",
        generationStartedAt: null,
        content: JSON.stringify(validated),
        conceptsTaught: JSON.stringify(
          validated.keyTerms.map(({ term }) => term),
        ),
        plan: JSON.stringify(plan),
        estimatedMinutes: validated.estimatedMinutes,
        error: null,
        reviewStatus,
        reviewNotes,
      })
      .where(
        and(eq(lessons.id, lessonId), eq(lessons.status, "generating")),
      )
      .run();
    return true;
  } catch (error) {
    db.update(lessons)
      .set({
        status: "failed",
        generationStartedAt: null,
        error: errorMessage(error),
        content: null,
        conceptsTaught: null,
        plan: null,
        estimatedMinutes: null,
        reviewStatus: null,
        reviewNotes: null,
      })
      .where(
        and(eq(lessons.id, lessonId), eq(lessons.status, "generating")),
      )
      .run();
    return false;
  }
}

async function refreshCourseStatus(courseId: string) {
  const courseModules = await db
    .select({ id: modules.id })
    .from(modules)
    .where(eq(modules.courseId, courseId));
  const moduleIds = courseModules.map(({ id }) => id);
  const lessonStatuses = moduleIds.length
    ? await db
        .select({ status: lessons.status })
        .from(lessons)
        .where(inArray(lessons.moduleId, moduleIds))
    : [];

  const stillGenerating = lessonStatuses.some(
    ({ status }) => status === "pending" || status === "generating",
  );
  const allReady =
    lessonStatuses.length > 0 &&
    lessonStatuses.every(({ status }) => status === "ready");
  const status = stillGenerating ? "generating" : allReady ? "ready" : "failed";
  const error =
    status === "failed" ? "One or more lessons failed to generate." : null;
  await db.update(courses).set({ status, error }).where(eq(courses.id, courseId));
}

export async function generateLessonById(lessonId: string): Promise<boolean> {
  const lesson = await db.query.lessons.findFirst({
    where: eq(lessons.id, lessonId),
  });
  if (!lesson) throw new Error("Lesson not found.");
  const courseModule = await db.query.modules.findFirst({
    where: eq(modules.id, lesson.moduleId),
  });
  if (!courseModule) throw new Error("Course module not found.");

  const generationStartedAt = Date.now();
  const staleBefore = lessonGenerationStaleBefore(generationStartedAt);
  const claim = db
    .update(lessons)
    .set({
      status: "generating",
      generationStartedAt,
      content: null,
      conceptsTaught: null,
      plan: null,
      estimatedMinutes: null,
      error: null,
      reviewStatus: null,
      reviewNotes: null,
    })
    .where(
      and(
        eq(lessons.id, lessonId),
        or(
          eq(lessons.status, "pending"),
          staleLessonGeneration(staleBefore),
        ),
      ),
    )
    .run();
  if (claim.changes === 0) return false;

  db.update(courses)
    .set({ status: "generating", error: null })
    .where(eq(courses.id, courseModule.courseId))
    .run();
  const generated = await generateClaimedLesson(courseModule.courseId, lessonId);
  await refreshCourseStatus(courseModule.courseId);
  return generated;
}

export async function generateModuleLessons(moduleId: string): Promise<void> {
  const courseModule = await db.query.modules.findFirst({
    where: eq(modules.id, moduleId),
  });
  if (!courseModule) throw new Error("Course module not found.");

  const pendingLessons = await db
    .select({ id: lessons.id })
    .from(lessons)
    .where(and(eq(lessons.moduleId, moduleId), eq(lessons.status, "pending")))
    .orderBy(asc(lessons.position));
  for (const lesson of pendingLessons) {
    await generateLessonById(lesson.id);
  }
  await refreshCourseStatus(courseModule.courseId);
}

export async function approveOutline(courseId: string): Promise<boolean> {
  const { moduleRows, lessonRows } = await loadGenerationContext(courseId);
  const firstLesson = orderedLessons(moduleRows, lessonRows)[0];
  if (!firstLesson) throw new Error("The course outline has no lessons.");

  db.update(courses)
    .set({
      outlineApprovedAt: Date.now(),
      status: "generating",
      error: null,
    })
    .where(eq(courses.id, courseId))
    .run();

  const generated = await generateLessonById(firstLesson.id);
  await refreshCourseStatus(courseId);
  return generated;
}

export async function failUnresolvedLessons(
  courseId: string,
  error: unknown,
): Promise<void> {
  const { lessonRows } = await loadGenerationContext(courseId);
  const unresolvedIds = lessonRows
    .filter(
      (lesson) =>
        lesson.status === "pending" || lesson.status === "generating",
    )
    .map((lesson) => lesson.id);
  if (unresolvedIds.length) {
    await db
      .update(lessons)
      .set({
        status: "failed",
        generationStartedAt: null,
        error: errorMessage(error),
      })
      .where(inArray(lessons.id, unresolvedIds));
  }
  await db
    .update(courses)
    .set({ status: "failed", error: errorMessage(error) })
    .where(eq(courses.id, courseId));
}

export async function prepareLessonRetry(lessonId: string) {
  const lesson = await db.query.lessons.findFirst({
    where: eq(lessons.id, lessonId),
  });
  if (!lesson) throw new Error("Lesson not found.");
  const generationStartedAt = Date.now();
  const staleBefore = lessonGenerationStaleBefore(generationStartedAt);
  const isStaleGenerating =
    lesson.status === "generating" &&
    (lesson.generationStartedAt === null ||
      lesson.generationStartedAt < staleBefore);
  if (
    lesson.status !== "failed" &&
    lesson.reviewStatus !== "flagged" &&
    !isStaleGenerating
  ) {
    throw new Error("Only failed, flagged, or stalled lessons can be retried.");
  }
  const issuesToFix =
    lesson.reviewStatus === "flagged"
      ? LessonReviewV1.shape.issues
          .parse(JSON.parse(lesson.reviewNotes ?? "[]"))
          .filter((issue) => issue.severity === "major")
      : [];
  const courseModule = await db.query.modules.findFirst({
    where: eq(modules.id, lesson.moduleId),
  });
  if (!courseModule) throw new Error("Course module not found.");

  const claim = db.transaction((transaction) => {
    const result = transaction
      .update(lessons)
      .set({
        status: "generating",
        generationStartedAt,
        content: null,
        conceptsTaught: null,
        plan: null,
        estimatedMinutes: null,
        error: null,
        reviewStatus: null,
        reviewNotes: null,
      })
      .where(
        and(
          eq(lessons.id, lessonId),
          or(
            eq(lessons.status, "failed"),
            eq(lessons.reviewStatus, "flagged"),
            staleLessonGeneration(staleBefore),
          ),
        ),
      )
      .run();
    if (result.changes > 0) {
      transaction
        .update(courses)
        .set({ status: "generating", error: null })
        .where(eq(courses.id, courseModule.courseId))
        .run();
    }
    return result;
  });
  if (claim.changes === 0) {
    throw new Error("This lesson is already being regenerated.");
  }

  return { courseId: courseModule.courseId, lessonId, issuesToFix };
}

export async function retryFailedLesson({
  courseId,
  lessonId,
  issuesToFix,
}: Awaited<ReturnType<typeof prepareLessonRetry>>): Promise<void> {
  await generateClaimedLesson(courseId, lessonId, issuesToFix);
  await refreshCourseStatus(courseId);
}

export async function failLessonRetry(
  { courseId, lessonId }: Awaited<ReturnType<typeof prepareLessonRetry>>,
  error: unknown,
): Promise<void> {
  await db
    .update(lessons)
    .set({
      status: "failed",
      generationStartedAt: null,
      error: errorMessage(error),
      content: null,
      conceptsTaught: null,
      plan: null,
      estimatedMinutes: null,
      reviewStatus: null,
      reviewNotes: null,
    })
    .where(and(eq(lessons.id, lessonId), eq(lessons.status, "generating")));
  await refreshCourseStatus(courseId);
}
