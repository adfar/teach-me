import Link from "next/link";
import { notFound } from "next/navigation";
import { LessonBlocks } from "@/components/LessonBlocks";
import { LessonPrefetch } from "@/components/LessonPrefetch";
import { getLessonWithNavigation } from "@/db/queries";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function LessonPage({
  params,
}: {
  params: Promise<{ id: string; lessonId: string }>;
}) {
  const { id, lessonId } = await params;
  const result = await getLessonWithNavigation(id, lessonId);
  if (!result) notFound();
  const {
    detail,
    module,
    lesson,
    content,
    reviewIssues,
    previousLesson,
    nextLesson,
    existingProgress,
  } = result;

  if (!content) {
    return (
      <div className="reading-shell">
        <Link className="back-link" href={`/courses/${id}`}>← Course overview</Link>
        <header className="lesson-header">
          <p className="eyebrow">{module.title}</p>
          <h1>{lesson.title}</h1>
          <p>{lesson.error ?? "This lesson is still being generated."}</p>
        </header>
      </div>
    );
  }

  const estimatedMinutes =
    lesson.estimatedMinutes ??
    (content.schemaVersion !== 1 ? content.estimatedMinutes : null);

  return (
    <article className="reading-shell">
      <LessonPrefetch
        nextLessonId={
          lesson.status === "ready" && nextLesson?.status === "pending"
            ? nextLesson.id
            : null
        }
      />
      <Link className="back-link" href={`/courses/${id}`}>← {detail.course.title}</Link>
      <header className="lesson-header">
        <p className="eyebrow">{module.title}</p>
        <h1>{lesson.title}</h1>
        <p>{lesson.summary}</p>
        <div className="lesson-header-meta">
          {estimatedMinutes && (
            <span className="lesson-progress-note">
              About {estimatedMinutes} minutes
            </span>
          )}
          {existingProgress?.completedAt && (
            <span className="lesson-progress-note">
              Completed
              {existingProgress.quizScore !== null &&
                existingProgress.quizTotal !== null &&
                ` · quiz ${existingProgress.quizScore}/${existingProgress.quizTotal}`}
            </span>
          )}
        </div>
      </header>

      <LessonBlocks
        courseId={id}
        lessonId={lesson.id}
        content={content}
        initiallyCompleted={Boolean(existingProgress?.completedAt)}
        isFlagged={lesson.reviewStatus === "flagged"}
        reviewIssues={reviewIssues}
      />

      <nav className="lesson-nav" aria-label="Lesson navigation">
        {previousLesson ? (
          <Link href={`/courses/${id}/lessons/${previousLesson.id}`}>
            <small>Previous lesson</small>{previousLesson.title}
          </Link>
        ) : <span />}
        {nextLesson && (
          <Link href={`/courses/${id}/lessons/${nextLesson.id}`}>
            <small>Next lesson</small>{nextLesson.title}
          </Link>
        )}
      </nav>
    </article>
  );
}
