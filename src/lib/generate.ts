import "server-only";

import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { asc, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { courses, lessons, modules } from "@/db/schema";
import {
  CourseV1,
  LessonContentV1,
  type CourseV1 as Course,
} from "@/lib/course-schema";

const MODEL = "claude-opus-4-8";
const MAX_TOKENS = 16_000;
const MAX_RETRIES = 2;

let anthropicClient: Anthropic | null = null;

function getClient(): Anthropic {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      "ANTHROPIC_API_KEY is not set. Add it to .env.local and try again.",
    );
  }
  anthropicClient ??= new Anthropic({ apiKey });
  return anthropicClient;
}

function sleep(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function withGenerationRetry<T>(
  request: () => Promise<{ parsed_output: T | null }>,
): Promise<T> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    try {
      const response = await request();
      if (response.parsed_output !== null) return response.parsed_output;
      if (attempt === MAX_RETRIES) {
        throw new Error("Claude returned no parsed structured output.");
      }
    } catch (error) {
      const retryable =
        error instanceof Anthropic.RateLimitError ||
        error instanceof Anthropic.InternalServerError;
      if (!retryable || attempt === MAX_RETRIES) throw error;
    }
    await sleep(1_000 * 2 ** attempt);
  }
  throw new Error("Generation retry loop ended unexpectedly.");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "An unknown generation error occurred.";
}

async function requestOutline(topic: string): Promise<Course> {
  return withGenerationRetry(() =>
    getClient().messages.parse({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      thinking: { type: "adaptive" },
      system:
        "You design focused, coherent courses. Teach with clear explanations and concrete examples, and order concepts by their dependencies so each lesson builds naturally on what came before.",
      messages: [
        {
          role: "user",
          content: `Create a complete course outline for this request: ${JSON.stringify(topic)}.

Requirements:
- Preserve the user's request exactly in the topic field.
- Use schemaVersion 1.
- Write a 2–3 sentence description.
- Create 3–6 modules in dependency order.
- Create 2–5 lessons per module.
- Give every module a concrete learning objective.
- Give every lesson a 1–2 sentence summary that clearly scopes its future full lesson.
- Avoid overlap between lessons and keep the course focused on the requested topic.`,
        },
      ],
      output_config: { format: zodOutputFormat(CourseV1) },
    }),
  );
}

function persistOutline(topic: string, outline: Course): string {
  const courseId = crypto.randomUUID();

  db.transaction((transaction) => {
    transaction
      .insert(courses)
      .values({
        id: courseId,
        topic,
        title: outline.title,
        description: outline.description,
        difficulty: outline.difficulty,
        prerequisites: JSON.stringify(outline.prerequisites),
        schemaVersion: 1,
        status: "generating",
        createdAt: Date.now(),
      })
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

  return courseId;
}

export async function createCourseOutline(topic: string): Promise<string> {
  const generated = await requestOutline(topic);
  const outline = CourseV1.parse({ ...generated, topic });
  return persistOutline(topic, outline);
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
        .map((lesson) => ({ title: lesson.title, summary: lesson.summary })),
    })),
  });

  return { outline, moduleRows, lessonRows };
}

async function generateLesson(
  courseId: string,
  lessonId: string,
): Promise<boolean> {
  await db
    .update(lessons)
    .set({ status: "generating", content: null, error: null })
    .where(eq(lessons.id, lessonId));

  try {
    const { outline, moduleRows, lessonRows } =
      await loadGenerationContext(courseId);
    const target = lessonRows.find((lesson) => lesson.id === lessonId);
    if (!target) throw new Error("Lesson not found in this course.");
    const targetModule = moduleRows.find(
      (courseModule) => courseModule.id === target.moduleId,
    );
    if (!targetModule) throw new Error("Lesson module not found.");

    const orderedLessonIds = moduleRows.flatMap((courseModule) =>
      lessonRows
        .filter((lesson) => lesson.moduleId === courseModule.id)
        .map((lesson) => lesson.id),
    );
    const targetIndex = orderedLessonIds.indexOf(lessonId);
    const precedingLessons = orderedLessonIds.slice(0, targetIndex).map((id) => {
      const lesson = lessonRows.find((item) => item.id === id);
      return lesson?.title;
    });

    const content = await withGenerationRetry(() =>
      getClient().messages.parse({
        model: MODEL,
        max_tokens: MAX_TOKENS,
        thinking: { type: "adaptive" },
        system:
          "You are an expert teacher writing one lesson in a larger course. Explain ideas clearly, use concrete worked examples, and stay within the assigned lesson scope so the course remains coherent and non-repetitive.",
        messages: [
          {
            role: "user",
            content: `Write the full content for one lesson.

Course context:
${JSON.stringify(
  {
    title: outline.title,
    description: outline.description,
    difficulty: outline.difficulty,
    fullOutline: outline.modules,
    lessonsThatPrecedeThisOne: precedingLessons,
    targetModule: targetModule.title,
    targetLesson: { title: target.title, summary: target.summary },
  },
  null,
  2,
)}

Requirements:
- Use schemaVersion 1 and write lesson prose in Markdown.
- Include at least one explanation block.
- Include at least one worked example in an example block.
- Add callouts only when they genuinely help.
- Include exactly one quiz block, and make it the final block.
- The quiz must contain 2–4 questions.
- Every quiz question must have exactly 4 choices, a correctIndex from 0–3, and exactly 4 per-choice explanations that explain why each corresponding choice is right or wrong.
- Cover this lesson's scope deeply without teaching material assigned to other lessons.`,
          },
        ],
        output_config: { format: zodOutputFormat(LessonContentV1) },
      }),
    );
    const validated = LessonContentV1.parse(content);

    await db
      .update(lessons)
      .set({ status: "ready", content: JSON.stringify(validated), error: null })
      .where(eq(lessons.id, lessonId));
    return true;
  } catch (error) {
    await db
      .update(lessons)
      .set({ status: "failed", error: errorMessage(error), content: null })
      .where(eq(lessons.id, lessonId));
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
  const error = status === "failed" ? "One or more lessons failed to generate." : null;
  await db.update(courses).set({ status, error }).where(eq(courses.id, courseId));
}

export async function generateCourseLessons(courseId: string): Promise<void> {
  const { lessonRows } = await loadGenerationContext(courseId);
  let cursor = 0;

  async function worker() {
    while (cursor < lessonRows.length) {
      const lesson = lessonRows[cursor];
      cursor += 1;
      await generateLesson(courseId, lesson.id);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(3, lessonRows.length) }, () => worker()),
  );
  await refreshCourseStatus(courseId);
}

export async function failUnresolvedLessons(
  courseId: string,
  error: unknown,
): Promise<void> {
  const { lessonRows } = await loadGenerationContext(courseId);
  const unresolvedIds = lessonRows
    .filter((lesson) => lesson.status === "pending" || lesson.status === "generating")
    .map((lesson) => lesson.id);
  if (unresolvedIds.length) {
    await db
      .update(lessons)
      .set({ status: "failed", error: errorMessage(error) })
      .where(inArray(lessons.id, unresolvedIds));
  }
  await db
    .update(courses)
    .set({ status: "failed", error: errorMessage(error) })
    .where(eq(courses.id, courseId));
}

export async function retryFailedLesson(lessonId: string): Promise<boolean> {
  const lesson = await db.query.lessons.findFirst({
    where: eq(lessons.id, lessonId),
  });
  if (!lesson) throw new Error("Lesson not found.");
  if (lesson.status !== "failed") {
    throw new Error("Only failed lessons can be retried.");
  }
  const courseModule = await db.query.modules.findFirst({
    where: eq(modules.id, lesson.moduleId),
  });
  if (!courseModule) throw new Error("Course module not found.");

  await db
    .update(courses)
    .set({ status: "generating", error: null })
    .where(eq(courses.id, courseModule.courseId));
  const succeeded = await generateLesson(courseModule.courseId, lessonId);
  await refreshCourseStatus(courseModule.courseId);
  return succeeded;
}
