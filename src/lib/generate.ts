import "server-only";

import { and, asc, eq, inArray, isNull, lt, or } from "drizzle-orm";
import { db } from "@/db";
import { courses, lessons, modules } from "@/db/schema";
import {
  CourseV1,
  IntakeChatResponseV1,
  IntakeConversationV1,
  LearnerProfileV1,
  LessonContentStructured,
  LessonContentV4,
  LessonContentV4Draft,
  LessonReviewV1,
  type CourseV1 as Course,
  type IntakeConversationV1 as IntakeConversation,
  type LearnerProfileV1 as LearnerProfile,
  type LessonContentV4 as LessonContent,
  type LessonContentV4Draft as LessonContentDraft,
  type LessonReviewIssueV1 as LessonReviewIssue,
  type LessonReviewV1 as LessonReview,
} from "@/lib/course-schema";
import { generateStructured } from "@/lib/llm";

type GenerationBackend = "api" | "subscription" | "codex";

const LESSON_GENERATION_BACKEND = (process.env.LESSON_GENERATION_BACKEND ??
  "codex") as GenerationBackend;
const LESSON_MODEL =
  process.env.GENERATION_MODEL ??
  (LESSON_GENERATION_BACKEND === "codex"
    ? "gpt-5.6-sol"
    : "claude-opus-5");
const PLANNING_MODEL = process.env.PLANNING_MODEL ?? "claude-sonnet-5";
const REVIEW_BACKEND = (process.env.REVIEW_BACKEND ?? "api") as
  GenerationBackend;
const REVIEW_MODEL =
  process.env.REVIEW_MODEL ??
  (REVIEW_BACKEND === "codex" ? "gpt-5.6-sol" : "claude-sonnet-5");
const MAX_TOKENS = 16_000;
const DEFAULT_LESSON_GENERATION_STALE_MS = 15 * 60 * 1_000;
const COURSE_STYLE_RULES = `
Course-writing rules:
- Scope each lesson for 20–30 total minutes, including reading, examples, activities, and checks. Give it one primary outcome and at most two or three tightly related supporting outcomes. Split material instead of compressing it.
- Write like a coherent textbook, not a study guide or glossary. Build a narrative from why the topic matters, through prior knowledge and new ideas, into examples and application, then a concise conclusion and connection forward.
- Use paragraphs as the main teaching form. Headings, lists, tables, and callouts may support the narrative but never replace it.
- Define unfamiliar vocabulary in plain language at first use, demonstrate it in context, and use terminology consistently. Never rely on additional unexplained terms.
- Explain both what and why. Move from simple to complex, show every important process step and its purpose, and distribute concrete examples throughout.
- Assume only prerequisites explicitly stated in the learner profile or concepts taught earlier. Briefly reactivate earlier ideas when needed.
- Put a brief activity or knowledge check after important material. It must support the stated outcome, cover only taught content, include corrective feedback, and count toward the time estimate.
- Use clear, direct language appropriate to the learner without sounding childish, overly academic, or needlessly technical. Avoid excessive bullets, fragments, dense prose, and repetitive framing.
- Begin with the capability the learner will gain, framed by a meaningful question, problem, or use. End by reinforcing the outcome and, when useful, connecting to the next lesson.
- When learners need to inspect spatial relationships, quantities, or a process, use a map, chart, or diagram instead of describing the visual entirely in prose. Explain how to read it, then ask the learner to reason from it.
- Never invent facts, sources, statistics, quotations, or purported real events. Qualify uncertainty and time-sensitive or disputed claims.`;

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

export function initialIntakeConversation(topic: string): IntakeConversation {
  return IntakeConversationV1.parse({
    schemaVersion: 1,
    messages: [
      {
        role: "assistant",
        content: `Let's make this useful. When you finish a course about ${topic}, what would you like to understand or be able to do?`,
      },
    ],
  });
}

export async function startCourseIntake(topic: string): Promise<{
  courseId: string;
  conversation: IntakeConversation;
}> {
  const conversation = initialIntakeConversation(topic);
  const courseId = crypto.randomUUID();

  db.insert(courses)
    .values({
      id: courseId,
      topic,
      schemaVersion: 1,
      status: "intake",
      intakeConversation: JSON.stringify(conversation),
      createdAt: Date.now(),
    })
    .run();

  return { courseId, conversation };
}

function conversationAnswers(
  conversation: IntakeConversation,
): LearnerProfile["answers"] {
  return conversation.messages.flatMap((message, index) => {
    if (message.role !== "user") return [];
    const question = conversation.messages[index - 1];
    return [
      {
        questionId: `chat-${index}`,
        question:
          question?.role === "assistant"
            ? question.content
            : "Additional learner context",
        answer: message.content,
      },
    ];
  });
}

async function requestIntakeChatTurn(
  topic: string,
  conversation: IntakeConversation,
) {
  const learnerReplyCount = conversation.messages.filter(
    ({ role }) => role === "user",
  ).length;
  const mustFinish = learnerReplyCount >= 3;
  const generated = await generateStructured({
    model: PLANNING_MODEL,
    system:
      "You are having a brief, natural conversation to understand a learner before designing their course. Ask one useful question at a time, respond to what they actually said, and stop as soon as you have enough context. Never sound like a survey or list multiple questions.",
    prompt: `Continue this intake conversation for a course about ${JSON.stringify(topic)}.

Conversation:
${JSON.stringify(conversation.messages, null, 2)}

You need only enough information to determine:
- the concrete capability or understanding the learner wants;
- their relevant background and prior exposure to this topic;
- any preference or constraint that would materially affect examples, emphasis, or sequencing.

Rules:
- Ask at most one short follow-up in reply.
- Do not ask for information already provided or ask generic learning-style questions.
- If the existing conversation provides enough context, set ready=true, briefly acknowledge the goal, and provide a conservative profile.
- Set derivedLevel from demonstrated topic-specific knowledge, not confidence or ambition.
- In goals, capture the concrete desired capability and any useful emphasis or constraint.
- In background, include only knowledge or experience the learner actually reported; say what is unknown instead of guessing.
- The entire intake may contain no more than three learner replies. ${mustFinish ? "This is the third learner reply, so you MUST set ready=true and provide the best faithful profile possible." : "Prefer finishing now when the course can be designed responsibly."}
- When ready=false, profile must be null. When ready=true, profile must be present.`,
    schema: IntakeChatResponseV1,
    maxTokens: 2_000,
    effort: "low",
  });

  return IntakeChatResponseV1.parse(generated);
}

async function requestOutline(
  topic: string,
  learnerProfile: LearnerProfile,
): Promise<Course> {
  const generated = await generateStructured({
    model: PLANNING_MODEL,
    system:
      "You design focused, coherent courses. Order concepts by their dependencies, scope every lesson for deep study, and adapt the course to the learner rather than producing a generic table of contents.",
    prompt: `Create a complete course outline for this request: ${JSON.stringify(topic)}.

Learner profile:
${JSON.stringify(
  {
    derivedLevel: learnerProfile.derivedLevel,
    goals: learnerProfile.goals,
    background: learnerProfile.background,
  },
  null,
  2,
)}

${COURSE_STYLE_RULES}

Requirements:
- Preserve the user's request exactly in the topic field and use schemaVersion 1.
- Condition the difficulty, prerequisites, sequencing, examples, and scope on the learner profile.
- Write a 2–3 sentence description.
- Create 3–6 modules in dependency order and 2–5 lessons per module.
- Give every module a concrete learning objective.
- Scope every lesson for 20–30 minutes of genuine study. Give it one primary learning outcome and no more than 2–3 closely related supporting outcomes; state them concretely in the 1–2 sentence summary.
- If an outcome cannot be taught adequately in 30 minutes, divide it into multiple lessons rather than compressing or oversimplifying it.
- Prefer fewer ideas taught thoroughly over broad survey coverage.
- Avoid overlap between lessons and avoid assigning a lesson concepts that depend on later lessons.
- Keep the course focused on the concrete capability in the learner's goals.`,
    schema: CourseV1,
    maxTokens: 8_000,
    effort: "medium",
  });

  return CourseV1.parse({ ...generated, topic });
}

function replaceCourseOutline(
  courseId: string,
  outline: Course,
  status: "generating",
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

export async function continueCourseIntake(
  courseId: string,
  message: string,
) {
  const course = await db.query.courses.findFirst({
    where: eq(courses.id, courseId),
  });
  if (!course) throw new Error("Course not found.");
  if (course.status !== "intake") {
    throw new Error("This course intake has already finished.");
  }

  const conversation = course.intakeConversation
    ? IntakeConversationV1.parse(JSON.parse(course.intakeConversation))
    : initialIntakeConversation(course.topic);
  const withLearnerReply = IntakeConversationV1.parse({
    ...conversation,
    messages: [
      ...conversation.messages,
      { role: "user", content: message.trim() },
    ],
  });
  const response = await requestIntakeChatTurn(
    course.topic,
    withLearnerReply,
  );
  const updatedConversation = IntakeConversationV1.parse({
    ...withLearnerReply,
    messages: [
      ...withLearnerReply.messages,
      { role: "assistant", content: response.reply },
    ],
  });
  const learnerProfile = response.profile
    ? LearnerProfileV1.parse({
        schemaVersion: 1,
        answers: conversationAnswers(updatedConversation),
        ...response.profile,
      })
    : null;

  db.update(courses)
    .set({
      intakeConversation: JSON.stringify(updatedConversation),
      learnerProfile: learnerProfile ? JSON.stringify(learnerProfile) : null,
      status: learnerProfile ? "outlining" : "intake",
      error: null,
    })
    .where(eq(courses.id, courseId))
    .run();

  return {
    conversation: updatedConversation,
    ready: learnerProfile !== null,
  };
}

export async function designCourseFromIntake(courseId: string): Promise<void> {
  const course = await db.query.courses.findFirst({
    where: eq(courses.id, courseId),
  });
  if (!course) throw new Error("Course not found.");
  if (!course.learnerProfile) {
    throw new Error("Complete the course conversation before designing it.");
  }
  const learnerProfile = LearnerProfileV1.parse(
    JSON.parse(course.learnerProfile),
  );
  try {
    const outline = await requestOutline(course.topic, learnerProfile);
    replaceCourseOutline(courseId, outline, "generating");
    await startFirstLesson(courseId);
  } catch (error) {
    db.update(courses)
      .set({ status: "failed", error: errorMessage(error) })
      .where(eq(courses.id, courseId))
      .run();
    throw error;
  }
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
    const parsed = LessonContentStructured.safeParse(JSON.parse(lesson.content));
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

function normalizeLessonVisualReferences(
  content: LessonContentDraft,
): LessonContentDraft {
  const usedVisualIds = new Set<string>();
  const sectionsWithUniqueVisualIds = content.sections.map((section) => ({
    ...section,
    blocks: section.blocks.map((block) => {
      if (block.type !== "visual") return block;

      let id = block.id;
      let suffix = 2;
      while (usedVisualIds.has(id)) {
        id = `${block.id}-${suffix}`;
        suffix += 1;
      }
      usedVisualIds.add(id);
      return id === block.id ? block : { ...block, id };
    }),
  }));

  return {
    ...content,
    sections: sectionsWithUniqueVisualIds.map((section) => ({
      ...section,
      blocks: section.blocks.map((block) =>
        block.type === "exercise" &&
        block.visualId &&
        !usedVisualIds.has(block.visualId)
          ? { ...block, visualId: undefined }
          : block,
      ),
    })),
    quiz: {
      questions: content.quiz.questions.map((question) =>
        question.visualId && !usedVisualIds.has(question.visualId)
          ? { ...question, visualId: undefined }
          : question,
      ),
    },
  };
}

async function requestLessonContent({
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
}): Promise<LessonContent> {
  const generated = await generateStructured({
    model: LESSON_MODEL,
    system:
      "You are an expert teacher writing one substantial lesson in a larger course. Teach patiently from the learner's actual knowledge boundary, with precise definitions, causal explanations, fully worked examples, and useful practice.",
    prompt: `Write the complete content for the target lesson.

Course context:
${JSON.stringify(
  {
    title: outline.title,
    description: outline.description,
    difficulty: outline.difficulty,
    modules: outline.modules,
  },
  null,
  2,
)}

Learner profile:
${JSON.stringify(
  {
    derivedLevel: learnerProfile.derivedLevel,
    goals: learnerProfile.goals,
    background: learnerProfile.background,
  },
  null,
  2,
)}

Concept ledger from earlier ready structured lessons:
${JSON.stringify(conceptLedger, null, 2)}

Target module and lesson:
${JSON.stringify({ targetModule, targetLesson }, null, 2)}

${COURSE_STYLE_RULES}

Writing requirements:
- Use schemaVersion 4. Target 20–30 minutes total in 3–4 coherent sections, including examples, activities, and checks. Set each section's minutes and make their sum equal estimatedMinutes.
- Write all prose in Markdown.
- Assume the learner knows ONLY what their profile states plus concepts in the ledger. Explain everything else from scratch at first use.
- Define every new technical term, proper noun, notation, or named concept in plain language before using it in an argument. Never substitute a name for an explanation.
- Stay inside the target lesson's scope. Do not forward-reference or teach material assigned to later lessons.
- Make the first section open with the concrete capability this lesson builds and frame it around a meaningful question, problem, or practical use. Connect to relevant prior knowledge before introducing new material.
- Develop one continuous explanatory narrative across sections. Explain ideas step by step and distribute closely matched worked examples wherever they make the material concrete; include at least one in the lesson, but do not force one into a section where it would interrupt the narrative. Show every important intermediate step and why it is valid; never say “it follows that” to skip reasoning.
- Put an exercise block after each important section as an activity or knowledge check. Every exercise needs a useful hint and a complete solution that diagnoses likely misunderstandings, not merely the answer.
- Make the final section include a concise narrative conclusion that reinforces the primary outcome and, when appropriate, connects it to the next lesson in the outline.
- Add visual blocks wherever seeing the information is materially better than verbal description. Geography and spatial-comparison lessons should normally contain a map; quantitative comparisons or trends should use a chart; systems, sequences, and causal relationships should use a diagram.
- For maps, use exact present-day country or U.S. state names in highlightedRegions and latitude/longitude markers for specific places. The renderer supplies authoritative base geography; do not invent polygon coordinates. A region label is visible map text: use distinct labels only when each belongs inside one specific region. When several regions share one category, give them the exact same label so the renderer groups it into one legend entry rather than printing it repeatedly.
- For charts, include only values you can state accurately from the lesson context. Never fabricate statistics to make a chart. Prefer a diagram when exact quantitative data is unavailable.
- Give every visual a unique stable id, useful title and caption, and complete altText that communicates its instructional meaning without merely listing colors.
- When an exercise or quiz question requires interpreting a visual, set visualId to that visual's id and make the answer depend on evidence visible in it. Do not set visualId for questions that can be answered without the visual.
- Do not repeat the visual's entire content in nearby prose before asking the learner to interpret it.
- Use callouts sparingly and only for a genuine warning, tip, or clarifying analogy.
- Write enough substantive explanation, examples, and practice to occupy the stated time. Never pad with filler, restatement, generic encouragement, or repeated summaries.
- Depth beats breadth. Teach a few ideas until the learner can use them.
- Add a glossary of at least 3 important terms introduced by this lesson, with concise plain-language definitions. Do not list terms assigned to later lessons.
- Write 3–6 quiz questions spanning the lesson's important objectives.
- Test whether the learner can explain or apply what the lesson taught. Do not test facts absent from the lesson sections.
- Every question must have exactly 4 plausible choices and one correctIndex from 0–3.
- Supply exactly 4 per-choice explanations for each question, aligned by index, explaining specifically why that choice is right or wrong.
- Avoid trick wording, trivia, and choices distinguishable by superficial cues.${reviewFixInstructions(issuesToFix)}`,
    schema: LessonContentV4Draft,
    maxTokens: MAX_TOKENS,
    effort: "medium",
    backend: LESSON_GENERATION_BACKEND,
  });

  return LessonContentV4.parse(normalizeLessonVisualReferences(generated));
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
- Whether the lesson follows the supplied 20–30 minute scope and coherent textbook-like narrative rather than reading as disconnected notes.
- Whether maps, charts, and diagrams are accurate, legible from their structured data, instructionally necessary, and correctly referenced by activities or quiz questions.
- Whether the lesson stays within its assigned title and summary.
- Whether it substantially teaches material owned by another lesson in the outline.
- Whether every quiz correctIndex points to the actually correct choice.
- Whether all four per-choice explanations for every quiz question truthfully explain why the corresponding choice is right or wrong.

List every specific issue you find. Use severity "major" when the problem could materially misteach or misassess the learner; otherwise use "minor" for advisory improvements. Return passed=false only when there is at least one major issue. Minor issues may be present when passed=true.`,
    schema: LessonReviewV1,
    maxTokens: 4_000,
    effort: "medium",
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
    const validated = await requestLessonContent({
      outline,
      learnerProfile,
      conceptLedger,
      targetModule: moduleContext,
      targetLesson,
      issuesToFix,
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
        plan: null,
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

async function startFirstLesson(courseId: string): Promise<boolean> {
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
