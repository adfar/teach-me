"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type {
  LessonContentV1,
  LessonReviewIssueV1,
} from "@/lib/course-schema";
import { Quiz } from "./Quiz";

function Markdown({ children }: { children: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{children}</ReactMarkdown>
    </div>
  );
}

export function LessonBlocks({
  lessonId,
  content,
  isFlagged,
  reviewIssues,
}: {
  lessonId: string;
  content: LessonContentV1;
  isFlagged: boolean;
  reviewIssues: LessonReviewIssueV1[];
}) {
  const router = useRouter();
  const [showReviewWarning, setShowReviewWarning] = useState(true);
  const [isRegenerating, setIsRegenerating] = useState(false);
  const [regenerationError, setRegenerationError] = useState<string | null>(
    null,
  );

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
      router.refresh();
      if (result.status !== "ready") {
        throw new Error("The lesson could not be regenerated.");
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

  return (
    <div className="lesson-blocks">
      {showReviewWarning && isFlagged && (
        <aside className="generation-banner failed" role="alert">
          <div className="w-full">
            <strong>Quality review found issues in this lesson</strong>
            {reviewIssues.length > 0 && (
              <ul className="mt-2 list-disc pl-5">
                {reviewIssues.map((issue, index) => (
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
      {content.blocks.map((block, index) => {
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
      })}
    </div>
  );
}
