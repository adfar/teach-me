import "server-only";

import { asc, desc, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import {
  LessonContentV1,
  LessonReviewV1,
  type LessonReviewIssueV1,
} from "@/lib/course-schema";
import { db } from "./index";
import { courses, lessons, modules, progress } from "./schema";

const prerequisitesSchema = z.array(z.string());

export type LessonSummary = Omit<
  typeof lessons.$inferSelect,
  "content" | "reviewNotes"
> & {
  reviewIssues: LessonReviewIssueV1[];
  progress: typeof progress.$inferSelect | null;
};

export type CourseDetail = {
  course: typeof courses.$inferSelect & { prerequisitesList: string[] };
  modules: Array<
    typeof modules.$inferSelect & {
      lessons: LessonSummary[];
    }
  >;
};

export function parsePrerequisites(value: string | null): string[] {
  return prerequisitesSchema.parse(JSON.parse(value ?? "[]"));
}

export function parseLessonContent(value: string | null): LessonContentV1 {
  if (!value) {
    throw new Error("This lesson does not have generated content.");
  }
  return LessonContentV1.parse(JSON.parse(value));
}

export function parseLessonReviewIssues(
  value: string | null,
): LessonReviewIssueV1[] {
  return value
    ? LessonReviewV1.shape.issues.parse(JSON.parse(value))
    : [];
}

export async function getCourseDetail(
  courseId: string,
): Promise<CourseDetail | null> {
  const course = await db.query.courses.findFirst({
    where: eq(courses.id, courseId),
  });
  if (!course) return null;

  const courseModules = await db
    .select()
    .from(modules)
    .where(eq(modules.courseId, courseId))
    .orderBy(asc(modules.position));
  const moduleIds = courseModules.map((module) => module.id);

  const lessonRows = moduleIds.length
    ? await db
        .select({
          id: lessons.id,
          moduleId: lessons.moduleId,
          position: lessons.position,
          title: lessons.title,
          summary: lessons.summary,
          status: lessons.status,
          error: lessons.error,
          reviewStatus: lessons.reviewStatus,
          reviewNotes: lessons.reviewNotes,
          lessonId: progress.lessonId,
          completedAt: progress.completedAt,
          quizScore: progress.quizScore,
          quizTotal: progress.quizTotal,
        })
        .from(lessons)
        .leftJoin(progress, eq(progress.lessonId, lessons.id))
        .where(inArray(lessons.moduleId, moduleIds))
        .orderBy(asc(lessons.position))
    : [];

  return {
    course: { ...course, prerequisitesList: parsePrerequisites(course.prerequisites) },
    modules: courseModules.map((module) => ({
      ...module,
      lessons: lessonRows
        .filter((lesson) => lesson.moduleId === module.id)
        .map((lesson) => ({
          id: lesson.id,
          moduleId: lesson.moduleId,
          position: lesson.position,
          title: lesson.title,
          summary: lesson.summary,
          status: lesson.status,
          error: lesson.error,
          reviewStatus: lesson.reviewStatus,
          reviewIssues: parseLessonReviewIssues(lesson.reviewNotes),
          progress: lesson.lessonId
            ? {
                lessonId: lesson.lessonId,
                completedAt: lesson.completedAt,
                quizScore: lesson.quizScore,
                quizTotal: lesson.quizTotal,
              }
            : null,
        })),
    })),
  };
}

export async function listCourseDetails(): Promise<CourseDetail[]> {
  const rows = await db.select({ id: courses.id }).from(courses).orderBy(desc(courses.createdAt));
  return (
    await Promise.all(rows.map(({ id }) => getCourseDetail(id)))
  ).filter((course): course is CourseDetail => course !== null);
}

export async function getLessonWithNavigation(
  courseId: string,
  lessonId: string,
) {
  const detail = await getCourseDetail(courseId);
  if (!detail) return null;

  const orderedLessons = detail.modules.flatMap((module) => module.lessons);
  const currentIndex = orderedLessons.findIndex((lesson) => lesson.id === lessonId);
  if (currentIndex === -1) return null;

  const lesson = await db.query.lessons.findFirst({
    where: eq(lessons.id, lessonId),
  });
  if (!lesson) return null;

  const currentModule = detail.modules.find((item) => item.id === lesson.moduleId);
  if (!currentModule) return null;

  return {
    detail,
    module: currentModule,
    lesson,
    content: lesson.status === "ready" ? parseLessonContent(lesson.content) : null,
    reviewIssues: orderedLessons[currentIndex].reviewIssues,
    existingProgress: orderedLessons[currentIndex].progress,
    previousLesson: orderedLessons[currentIndex - 1] ?? null,
    nextLesson: orderedLessons[currentIndex + 1] ?? null,
  };
}
