"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import type { CourseDetail } from "@/db/queries";

export function CourseOverview({ initialDetail }: { initialDetail: CourseDetail }) {
  const [detail, setDetail] = useState(initialDetail);
  const [retrying, setRetrying] = useState<string | null>(null);
  const [generatingLessons, setGeneratingLessons] = useState<Set<string>>(
    () => new Set(),
  );
  const [generatingModules, setGeneratingModules] = useState<Set<string>>(
    () => new Set(),
  );
  const [actionError, setActionError] = useState<string | null>(null);
  const allLessons = detail.modules.flatMap((courseModule) => courseModule.lessons);
  const hasActiveLessons = allLessons.some(
    (lesson) => lesson.status === "generating" && !lesson.generationStalled,
  );
  const awaitingFirstLesson =
    detail.course.status === "generating" &&
    allLessons.length > 0 &&
    allLessons.every((lesson) => lesson.status === "pending");
  const shouldPoll =
    detail.course.status === "outlining" ||
    awaitingFirstLesson ||
    hasActiveLessons;

  useEffect(() => {
    if (!shouldPoll) return;
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
  }, [detail.course.id, shouldPoll]);

  function updateLessonStatus(lessonIds: string[], status: string) {
    setDetail((current) => ({
      ...current,
      course: { ...current.course, status: "generating", error: null },
      modules: current.modules.map((courseModule) => ({
        ...courseModule,
        lessons: courseModule.lessons.map((lesson) =>
          lessonIds.includes(lesson.id)
            ? {
                ...lesson,
                status,
                generationStartedAt: Date.now(),
                generationStalled: false,
                error: null,
              }
            : lesson,
        ),
      })),
    }));
  }

  async function generateLesson(lessonId: string) {
    setGeneratingLessons((current) => new Set(current).add(lessonId));
    setActionError(null);
    updateLessonStatus([lessonId], "generating");
    try {
      const response = await fetch(`/api/lessons/${lessonId}/generate`, {
        method: "POST",
      });
      const result: { started?: boolean; error?: string } = await response.json();
      if (!response.ok) {
        throw new Error(result.error ?? "Could not generate this lesson.");
      }
    } catch (error) {
      setActionError(
        error instanceof Error
          ? error.message
          : "Could not generate this lesson.",
      );
    } finally {
      setGeneratingLessons((current) => {
        const next = new Set(current);
        next.delete(lessonId);
        return next;
      });
    }
  }

  async function generateModule(moduleId: string, lessonIds: string[]) {
    setGeneratingModules((current) => new Set(current).add(moduleId));
    setActionError(null);
    updateLessonStatus(lessonIds, "generating");
    try {
      const response = await fetch(`/api/modules/${moduleId}/generate`, {
        method: "POST",
      });
      const result: { error?: string } = await response.json();
      if (!response.ok) {
        throw new Error(result.error ?? "Could not generate this unit.");
      }
    } catch (error) {
      setActionError(
        error instanceof Error
          ? error.message
          : "Could not generate this unit.",
      );
    } finally {
      setGeneratingModules((current) => {
        const next = new Set(current);
        next.delete(moduleId);
        return next;
      });
    }
  }

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
                generationStartedAt: Date.now(),
                generationStalled: false,
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
      const result: { status?: "generating"; error?: string } = await response.json();
      if (!response.ok) throw new Error(result.error ?? "Could not retry this lesson.");
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
        <p className="eyebrow">
          {detail.course.difficulty
            ? `${detail.course.difficulty} course`
            : "Personalized course"}
        </p>
        <h1>{detail.course.title ?? detail.course.topic}</h1>
        <p className="course-description">
          {detail.course.description ??
            `A custom learning path about ${detail.course.topic}.`}
        </p>
        <div className="meta-row">
          <span className={`badge badge-${detail.course.status}`}>
            {detail.course.status.replace("_", " ")}
          </span>
          {detail.modules.length > 0 && (
            <span className="badge">{detail.modules.length} modules</span>
          )}
          {allLessons.length > 0 && (
            <span className="badge">{completionPercent}% complete</span>
          )}
        </div>
        {detail.course.difficulty && (
          <div className="prerequisites">
            <strong>Prerequisites</strong>
            <p>
              {detail.course.prerequisitesList.length
                ? detail.course.prerequisitesList.join(" · ")
                : "None—start right here."}
            </p>
          </div>
        )}
      </header>

      {detail.course.status === "intake" && (
        <section className="course-state-card">
          <h2>Finish shaping your course</h2>
          <p>
            Continue the short conversation so the course designer understands
            your goal and starting point.
          </p>
          <Link
            className="button"
            href={`/courses/${detail.course.id}/intake`}
          >
            Continue intake
          </Link>
        </section>
      )}

      {detail.course.status === "outlining" && (
        <div className="generation-banner" role="status">
          <span className="spinner" aria-hidden="true" />
          Your learning path is being designed and the first lesson will begin
          generating automatically.
        </div>
      )}

      {hasActiveLessons && (
        <div className="generation-banner" role="status">
          <span className="spinner" aria-hidden="true" />
          Lessons are being written. The list updates as each one is ready.
        </div>
      )}
      {detail.course.status === "failed" && (
        <div className="generation-banner failed" role="alert">
          {detail.course.error ??
            "Some lessons could not be generated. Retry failed lessons below."}
        </div>
      )}
      {actionError && <p className="error-text" role="alert">{actionError}</p>}

      {detail.modules.length > 0 &&
        detail.course.status !== "outlining" &&
        detail.course.status !== "intake" && (
      <div className="module-list">
        {detail.modules.map((courseModule, moduleIndex) => (
          <section className="module-card" key={courseModule.id}>
            <div className="module-heading">
              <div className="module-heading-row">
                <div>
                  <p className="module-number">Module {moduleIndex + 1}</p>
                  <h2>{courseModule.title}</h2>
                </div>
                {courseModule.lessons.some(
                  (lesson) => lesson.status === "pending",
                ) && (
                  <button
                    className="button button-secondary module-generate-button"
                    type="button"
                    onClick={() =>
                      generateModule(
                        courseModule.id,
                        courseModule.lessons
                          .filter((lesson) => lesson.status === "pending")
                          .map((lesson) => lesson.id),
                      )
                    }
                    disabled={generatingModules.has(courseModule.id)}
                  >
                    {generatingModules.has(courseModule.id)
                      ? "Starting…"
                      : "Generate this unit"}
                  </button>
                )}
              </div>
              <p className="module-objective">{courseModule.objective}</p>
            </div>
            <ol className="lesson-list">
              {courseModule.lessons.map((lesson) => {
                const complete = Boolean(lesson.progress?.completedAt);
                const showComplete = complete && lesson.status === "ready";
                const iconClass = showComplete
                  ? "complete"
                  : lesson.generationStalled
                    ? "failed"
                    : lesson.status;
                const iconLabel = showComplete
                  ? "Completed"
                  : lesson.generationStalled
                    ? "Generation stalled"
                    : lesson.status === "ready"
                      ? "Ready, not completed"
                      : lesson.status === "failed"
                        ? "Generation failed"
                        : lesson.status === "generating"
                          ? "Generating"
                          : "Waiting to generate";
                const isFlagged = lesson.reviewStatus === "flagged";
                const minorIssues = lesson.reviewIssues.filter(
                  (issue) => issue.severity === "minor",
                );
                return (
                  <li className="lesson-row" key={lesson.id}>
                    <span className={`status-icon ${iconClass}`} aria-label={iconLabel}>
                      {showComplete
                        ? "✓"
                        : lesson.status === "failed"
                          ? "!"
                          : lesson.status === "ready"
                            ? null
                            : lesson.status === "generating" &&
                                !lesson.generationStalled
                              ? <span className="spinner" />
                              : lesson.generationStalled
                                ? "!"
                                : lesson.position + 1}
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
                        <span
                          className={`badge badge-${lesson.generationStalled ? "failed" : lesson.status}`}
                        >
                          {lesson.generationStalled ? "stalled" : lesson.status}
                        </span>
                        {lesson.reviewStatus && (
                          <span
                            className={`badge ${isFlagged ? "badge-failed" : "badge-ready"}`}
                          >
                            {isFlagged ? "Review warning" : "Review passed"}
                          </span>
                        )}
                      </div>
                      <p className="lesson-summary">
                        {lesson.generationStalled
                          ? "Generation stalled before this lesson finished. Start it again to continue."
                          : lesson.status === "failed"
                            ? lesson.error ?? "Generation failed."
                            : lesson.summary}
                      </p>
                      {lesson.estimatedMinutes && (
                        <p className="lesson-time">
                          About {lesson.estimatedMinutes} minutes
                        </p>
                      )}
                      {minorIssues.length > 0 && (
                        <details className="reviewer-notes reviewer-notes-compact">
                          <summary>Reviewer notes ({minorIssues.length})</summary>
                          <ul>
                            {minorIssues.map((issue, index) => (
                              <li key={`${issue.category}-${index}`}>
                                <strong className="capitalize">
                                  {issue.category}
                                </strong>
                                {" — "}
                                {issue.description}
                              </li>
                            ))}
                          </ul>
                        </details>
                      )}
                    </div>
                    <div className="lesson-actions">
                      {(lesson.status === "pending" ||
                        lesson.generationStalled) && (
                        <button
                          className="button button-secondary lesson-generate-button"
                          type="button"
                          onClick={() => generateLesson(lesson.id)}
                          disabled={generatingLessons.has(lesson.id)}
                        >
                          {generatingLessons.has(lesson.id)
                            ? "Generating…"
                            : lesson.generationStalled
                              ? "Retry"
                              : "Generate"}
                        </button>
                      )}
                      {!lesson.generationStalled &&
                        (lesson.status === "failed" || isFlagged) && (
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
                    </div>
                  </li>
                );
              })}
            </ol>
          </section>
        ))}
      </div>
      )}
    </>
  );
}
