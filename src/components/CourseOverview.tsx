"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { CourseDetail } from "@/db/queries";

export function CourseOverview({ initialDetail }: { initialDetail: CourseDetail }) {
  const [detail, setDetail] = useState(initialDetail);
  const [retrying, setRetrying] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const allLessons = detail.modules.flatMap((courseModule) => courseModule.lessons);
  const hasActiveLessons = allLessons.some(
    (lesson) => lesson.status === "pending" || lesson.status === "generating",
  );

  useEffect(() => {
    if (!hasActiveLessons && detail.course.status !== "generating") return;
    const interval = window.setInterval(async () => {
      try {
        const response = await fetch(`/api/courses/${detail.course.id}`, {
          cache: "no-store",
        });
        if (response.ok) setDetail((await response.json()) as CourseDetail);
      } catch {
        // The next poll will retry a transient local connection failure.
      }
    }, 1_500);
    return () => window.clearInterval(interval);
  }, [detail.course.id, detail.course.status, hasActiveLessons]);

  async function retryLesson(lessonId: string) {
    setRetrying(lessonId);
    setActionError(null);
    setDetail((current) => ({
      ...current,
      course: { ...current.course, status: "generating", error: null },
      modules: current.modules.map((courseModule) => ({
        ...courseModule,
        lessons: courseModule.lessons.map((lesson) =>
          lesson.id === lessonId
            ? {
                ...lesson,
                status: "generating",
                error: null,
                reviewStatus: null,
                reviewIssues: [],
              }
            : lesson,
        ),
      })),
    }));
    try {
      const response = await fetch(`/api/lessons/${lessonId}/retry`, { method: "POST" });
      const result: { error?: string } = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Could not retry this lesson.");
      const updated = await fetch(`/api/courses/${detail.course.id}`, { cache: "no-store" });
      if (updated.ok) setDetail((await updated.json()) as CourseDetail);
    } catch (error) {
      setActionError(error instanceof Error ? error.message : "Could not retry this lesson.");
    } finally {
      setRetrying(null);
    }
  }

  const completedCount = allLessons.filter((lesson) => lesson.progress?.completedAt).length;
  const completionPercent = allLessons.length
    ? Math.round((completedCount / allLessons.length) * 100)
    : 0;

  return (
    <>
      <header className="course-header">
        <p className="eyebrow">{detail.course.difficulty} course</p>
        <h1>{detail.course.title ?? detail.course.topic}</h1>
        <p className="course-description">{detail.course.description}</p>
        <div className="meta-row">
          <span className={`badge badge-${detail.course.status}`}>{detail.course.status}</span>
          <span className="badge">{detail.modules.length} modules</span>
          <span className="badge">{completionPercent}% complete</span>
        </div>
        <div className="prerequisites">
          <strong>Prerequisites</strong>
          <p>
            {detail.course.prerequisitesList.length
              ? detail.course.prerequisitesList.join(" · ")
              : "None—start right here."}
          </p>
        </div>
      </header>

      {(detail.course.status === "generating" || hasActiveLessons) && (
        <div className="generation-banner" role="status">
          <span className="spinner" aria-hidden="true" />
          Lessons are being written. This checklist updates as each one is ready.
        </div>
      )}
      {detail.course.status === "failed" && (
        <div className="generation-banner failed" role="alert">
          Some lessons could not be generated. Retry each failed lesson below.
        </div>
      )}
      {actionError && <p className="error-text" role="alert">{actionError}</p>}

      <div className="module-list">
        {detail.modules.map((courseModule, moduleIndex) => (
          <section className="module-card" key={courseModule.id}>
            <div className="module-heading">
              <p className="module-number">Module {moduleIndex + 1}</p>
              <h2>{courseModule.title}</h2>
              <p className="module-objective">{courseModule.objective}</p>
            </div>
            <ol className="lesson-list">
              {courseModule.lessons.map((lesson) => {
                const complete = Boolean(lesson.progress?.completedAt);
                const iconClass = complete ? "complete" : lesson.status;
                const isFlagged = lesson.reviewStatus === "flagged";
                return (
                  <li className="lesson-row" key={lesson.id}>
                    <span className={`status-icon ${iconClass}`} aria-label={complete ? "Complete" : lesson.status}>
                      {complete || lesson.status === "ready" ? "✓" : lesson.status === "failed" ? "!" : <span className="spinner" />}
                    </span>
                    <div>
                      <div className="flex flex-wrap items-center gap-2">
                        {lesson.status === "ready" ? (
                          <Link className="lesson-title link" href={`/courses/${detail.course.id}/lessons/${lesson.id}`}>
                            {lesson.title}
                          </Link>
                        ) : (
                          <span className="lesson-title">{lesson.title}</span>
                        )}
                        {isFlagged && (
                          <span className="badge badge-failed">
                            Review warning
                          </span>
                        )}
                      </div>
                      <p className="lesson-summary">
                        {lesson.status === "failed" ? lesson.error ?? "Generation failed." : lesson.summary}
                      </p>
                    </div>
                    {(lesson.status === "failed" || isFlagged) && (
                      <button
                        className="retry-button"
                        type="button"
                        onClick={() => retryLesson(lesson.id)}
                        disabled={retrying === lesson.id}
                      >
                        {retrying === lesson.id
                          ? "Regenerating…"
                          : isFlagged
                            ? "Regenerate"
                            : "Retry"}
                      </button>
                    )}
                  </li>
                );
              })}
            </ol>
          </section>
        ))}
      </div>
    </>
  );
}
