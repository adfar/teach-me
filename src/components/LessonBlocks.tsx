"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type {
  LessonContentAny,
  LessonReviewIssueV1,
  VisualBlockV4,
} from "@/lib/course-schema";
import type { CourseDetail } from "@/db/queries";
import { Quiz } from "./Quiz";
import { LessonVisual } from "./LessonVisual";

function Markdown({ children }: { children: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{children}</ReactMarkdown>
    </div>
  );
}

export function LessonBlocks({
  courseId,
  lessonId,
  content,
  initiallyCompleted,
  isFlagged,
  reviewIssues,
}: {
  courseId: string;
  lessonId: string;
  content: LessonContentAny;
  initiallyCompleted: boolean;
  isFlagged: boolean;
  reviewIssues: LessonReviewIssueV1[];
}) {
  const router = useRouter();
  const [showReviewWarning, setShowReviewWarning] = useState(true);
  const [isRegenerating, setIsRegenerating] = useState(false);
  const [isCompleted, setIsCompleted] = useState(initiallyCompleted);
  const [isSavingCompletion, setIsSavingCompletion] = useState(false);
  const [completionMessage, setCompletionMessage] = useState<string | null>(
    null,
  );
  const [completionError, setCompletionError] = useState<string | null>(null);
  const [regenerationError, setRegenerationError] = useState<string | null>(
    null,
  );
  const majorIssues = reviewIssues.filter(
    (issue) => issue.severity === "major",
  );
  const minorIssues = reviewIssues.filter(
    (issue) => issue.severity === "minor",
  );
  const visualsById: Record<string, VisualBlockV4> =
    content.schemaVersion === 4
      ? Object.fromEntries(
          content.sections.flatMap((section) =>
            section.blocks.flatMap((block) =>
              block.type === "visual" ? [[block.id, block]] : [],
            ),
          ),
        )
      : {};

  async function regenerateLesson() {
    setIsRegenerating(true);
    setRegenerationError(null);
    try {
      const response = await fetch(`/api/lessons/${lessonId}/retry`, {
        method: "POST",
      });
      const result: { status?: string; error?: string } = await response.json();
      if (!response.ok) {
        throw new Error(result.error ?? "Could not regenerate this lesson.");
      }

      while (true) {
        await new Promise((resolve) => window.setTimeout(resolve, 1_500));
        let updated: Response;
        try {
          updated = await fetch(`/api/courses/${courseId}`, {
            cache: "no-store",
          });
        } catch {
          continue;
        }
        if (!updated.ok) {
          throw new Error("Could not check the regenerated lesson.");
        }

        const detail = (await updated.json()) as CourseDetail;
        const lesson = detail.modules
          .flatMap((courseModule) => courseModule.lessons)
          .find((item) => item.id === lessonId);
        if (!lesson) {
          throw new Error("Could not find the regenerated lesson.");
        }
        if (lesson.status === "pending" || lesson.status === "generating") {
          continue;
        }

        router.refresh();
        if (lesson.status === "failed") {
          throw new Error(
            lesson.error ?? "The lesson could not be regenerated.",
          );
        }
        break;
      }
    } catch (error) {
      setRegenerationError(
        error instanceof Error
          ? error.message
          : "Could not regenerate this lesson.",
      );
    } finally {
      setIsRegenerating(false);
    }
  }

  async function toggleCompletion() {
    const completed = !isCompleted;
    setIsSavingCompletion(true);
    setCompletionMessage(null);
    setCompletionError(null);
    try {
      const response = await fetch(`/api/lessons/${lessonId}/progress`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "setCompletion", completed }),
      });
      const result: { error?: string } = await response.json();
      if (!response.ok) {
        throw new Error(
          result.error ?? "Could not update lesson completion.",
        );
      }
      setIsCompleted(completed);
      setCompletionMessage(
        completed
          ? "Lesson marked complete."
          : "Lesson marked as incomplete.",
      );
      router.refresh();
    } catch (error) {
      setCompletionError(
        error instanceof Error
          ? error.message
          : "Could not update lesson completion.",
      );
    } finally {
      setIsSavingCompletion(false);
    }
  }

  return (
    <div className="lesson-blocks">
      {showReviewWarning && isFlagged && (
        <aside className="generation-banner failed" role="alert">
          <div className="w-full">
            <strong>Quality review found major issues in this lesson</strong>
            {majorIssues.length > 0 && (
              <ul className="mt-2 list-disc pl-5">
                {majorIssues.map((issue, index) => (
                  <li key={`${issue.category}-${index}`}>
                    <strong className="capitalize">{issue.category}</strong>
                    {" — "}
                    {issue.description}
                  </li>
                ))}
              </ul>
            )}
            <div className="mt-3 flex flex-wrap gap-2">
              <button
                className="retry-button"
                type="button"
                onClick={regenerateLesson}
                disabled={isRegenerating}
              >
                {isRegenerating
                  ? "Regenerating…"
                  : "Regenerate this lesson"}
              </button>
              <button
                className="button button-secondary"
                type="button"
                onClick={() => setShowReviewWarning(false)}
              >
                Dismiss
              </button>
            </div>
            {regenerationError && (
              <p className="error-text" role="alert">
                {regenerationError}
              </p>
            )}
          </div>
        </aside>
      )}
      {minorIssues.length > 0 && (
        <details className="reviewer-notes">
          <summary>Reviewer notes ({minorIssues.length})</summary>
          <ul>
            {minorIssues.map((issue, index) => (
              <li key={`${issue.category}-${index}`}>
                <strong className="capitalize">{issue.category}</strong>
                {" — "}
                {issue.description}
              </li>
            ))}
          </ul>
        </details>
      )}
      {content.schemaVersion === 1 ? (
        content.blocks.map((block, index) => {
          if (block.type === "explanation") {
            return <Markdown key={index}>{block.markdown}</Markdown>;
          }
          if (block.type === "example") {
            return (
              <section className="example-card" key={index}>
                <h2>Worked example · {block.title}</h2>
                <Markdown>{block.markdown}</Markdown>
              </section>
            );
          }
          if (block.type === "callout") {
            return (
              <aside className={`callout callout-${block.variant}`} key={index}>
                <h2>{block.variant === "analogy" ? "A useful analogy" : block.variant === "warning" ? "Watch out" : "Tip"}</h2>
                <Markdown>{block.markdown}</Markdown>
              </aside>
            );
          }
          return <Quiz lessonId={lessonId} questions={block.questions} key={index} />;
        })
      ) : (
        <>
          <section className="key-terms" aria-labelledby="key-terms-heading">
            <h2 id="key-terms-heading">Key terms</h2>
            <dl>
              {content.keyTerms.map(({ term, definition }) => (
                <div key={term}>
                  <dt>{term}</dt>
                  <dd>{definition}</dd>
                </div>
              ))}
            </dl>
          </section>

          {content.sections.map((section, sectionIndex) => (
            <section className="lesson-section" key={`${section.heading}-${sectionIndex}`}>
              <header className="lesson-section-heading">
                <h2>{section.heading}</h2>
                <span>{section.minutes} min</span>
              </header>
              <div className="lesson-section-blocks">
                {section.blocks.map((block, blockIndex) => {
                  const key = `${sectionIndex}-${blockIndex}`;
                  if (block.type === "explanation") {
                    return <Markdown key={key}>{block.markdown}</Markdown>;
                  }
                  if (block.type === "example") {
                    return (
                      <section className="example-card" key={key}>
                        <h3>Worked example · {block.title}</h3>
                        <Markdown>{block.markdown}</Markdown>
                      </section>
                    );
                  }
                  if (block.type === "callout") {
                    return (
                      <aside className={`callout callout-${block.variant}`} key={key}>
                        <h3>{block.variant === "analogy" ? "A useful analogy" : block.variant === "warning" ? "Watch out" : "Tip"}</h3>
                        <Markdown>{block.markdown}</Markdown>
                      </aside>
                    );
                  }
                  if (block.type === "visual") {
                    return <LessonVisual block={block} key={key} />;
                  }
                  const referencedVisual = block.visualId
                    ? visualsById[block.visualId]
                    : undefined;
                  return (
                    <section className="exercise-card" key={key}>
                      <p className="exercise-label">Try it yourself</p>
                      {referencedVisual && (
                        <LessonVisual block={referencedVisual} compact />
                      )}
                      <Markdown>{block.prompt}</Markdown>
                      <div className="exercise-disclosures">
                        <details>
                          <summary>Show a hint</summary>
                          <Markdown>{block.hint}</Markdown>
                        </details>
                        <details>
                          <summary>Show the solution</summary>
                          <Markdown>{block.solution}</Markdown>
                        </details>
                      </div>
                    </section>
                  );
                })}
              </div>
            </section>
          ))}

          <Quiz
            lessonId={lessonId}
            questions={content.quiz.questions}
            visualsById={visualsById}
          />
        </>
      )}
      <section className="lesson-completion" aria-labelledby="lesson-completion-heading">
        <div>
          <h2 id="lesson-completion-heading">
            {isCompleted ? "Lesson complete" : "Finished with this lesson?"}
          </h2>
          <p>
            {isCompleted
              ? "This lesson counts toward your course progress."
              : "Mark it complete when you’re ready to count it toward your course progress."}
          </p>
        </div>
        <button
          className={`button ${isCompleted ? "button-secondary" : ""}`}
          type="button"
          onClick={toggleCompletion}
          disabled={isSavingCompletion}
        >
          {isSavingCompletion
            ? "Saving…"
            : isCompleted
              ? "Mark as incomplete"
              : "Mark lesson complete"}
        </button>
        {completionMessage && (
          <p className="form-note" role="status">
            {completionMessage}
          </p>
        )}
        {completionError && (
          <p className="error-text" role="alert">
            {completionError}
          </p>
        )}
      </section>
    </div>
  );
}
