"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";
import type { IntakeQuestionV1 } from "@/lib/course-schema";

type IntakeValue = string | string[];

export function CourseIntakeForm({
  courseId,
  questions,
}: {
  courseId: string;
  questions: IntakeQuestionV1[];
}) {
  const router = useRouter();
  const [answers, setAnswers] = useState<Record<string, IntakeValue>>(() =>
    Object.fromEntries(
      questions.map((question) => [
        question.id,
        question.kind === "multi" ? [] : "",
      ]),
    ),
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit = questions.every((question) => {
    const answer = answers[question.id];
    if (question.kind === "text") return typeof answer === "string";
    if (question.kind === "multi") {
      return Array.isArray(answer) && answer.length > 0;
    }
    return typeof answer === "string" && answer.length > 0;
  });

  function toggleMulti(questionId: string, option: string, checked: boolean) {
    setAnswers((current) => {
      const selected = current[questionId];
      const values = Array.isArray(selected) ? selected : [];
      return {
        ...current,
        [questionId]: checked
          ? [...values, option]
          : values.filter((value) => value !== option),
      };
    });
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!canSubmit) return;

    setSubmitting(true);
    setError(null);
    try {
      const response = await fetch(`/api/courses/${courseId}/intake`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          answers: questions.map((question) => ({
            questionId: question.id,
            answer: answers[question.id],
          })),
        }),
      });
      const result: { error?: string } = await response.json();
      if (!response.ok) {
        throw new Error(result.error ?? "Could not submit your answers.");
      }
      router.push(`/courses/${courseId}`);
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Could not submit your answers.",
      );
      setSubmitting(false);
    }
  }

  return (
    <form className="intake-form" onSubmit={submit}>
      {questions.map((question, questionIndex) => (
        <fieldset className="intake-question" key={question.id}>
          <legend>
            <span className="intake-question-number">
              Question {questionIndex + 1}
            </span>
            {question.question}
          </legend>
          <p className="intake-rationale">{question.rationale}</p>

          {question.kind === "text" ? (
            <textarea
              className="intake-textarea"
              value={answers[question.id] as string}
              onChange={(event) =>
                setAnswers((current) => ({
                  ...current,
                  [question.id]: event.target.value,
                }))
              }
              rows={4}
              disabled={submitting}
              aria-label={question.question}
            />
          ) : (
            <div className="intake-options">
              {question.options.map((option) => {
                const answer = answers[question.id];
                const checked =
                  question.kind === "multi"
                    ? Array.isArray(answer) && answer.includes(option)
                    : answer === option;
                return (
                  <label className="intake-option" key={option}>
                    <input
                      type={question.kind === "multi" ? "checkbox" : "radio"}
                      name={question.id}
                      value={option}
                      checked={checked}
                      onChange={(event) => {
                        if (question.kind === "multi") {
                          toggleMulti(
                            question.id,
                            option,
                            event.target.checked,
                          );
                        } else {
                          setAnswers((current) => ({
                            ...current,
                            [question.id]: option,
                          }));
                        }
                      }}
                      disabled={submitting}
                    />
                    <span>{option}</span>
                  </label>
                );
              })}
            </div>
          )}
        </fieldset>
      ))}

      <div className="intake-actions">
        <button
          className="button"
          type="submit"
          disabled={!canSubmit || submitting}
        >
          {submitting ? "Planning your course…" : "Create my outline"}
        </button>
        <p className={`form-note ${error ? "error-text" : ""}`} role="status">
          {error ??
            (submitting
              ? "You can review the outline before any lessons are written."
              : "Text questions are optional; all choices need an answer.")}
        </p>
      </div>
    </form>
  );
}
