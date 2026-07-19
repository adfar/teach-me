"use client";

import { useState } from "react";
import type { QuizQuestionV1 } from "@/lib/course-schema";

type SaveStatus = "idle" | "saving" | "saved" | "failed";

export function Quiz({ lessonId, questions }: { lessonId: string; questions: QuizQuestionV1[] }) {
  const [answers, setAnswers] = useState<Array<number | null>>(
    () => questions.map(() => null),
  );
  const [saveStatus, setSaveStatus] = useState<SaveStatus>("idle");
  const answeredAll = answers.every((answer) => answer !== null);
  const score = answers.reduce<number>(
    (total, answer, index) => total + (answer === questions[index].correctIndex ? 1 : 0),
    0,
  );

  async function saveProgress(finalScore: number) {
    setSaveStatus("saving");
    try {
      const response = await fetch(`/api/lessons/${lessonId}/progress`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ quizScore: finalScore, quizTotal: questions.length }),
      });
      if (!response.ok) throw new Error("Progress could not be saved.");
      setSaveStatus("saved");
    } catch {
      setSaveStatus("failed");
    }
  }

  function choose(questionIndex: number, choiceIndex: number) {
    if (answers[questionIndex] !== null) return;
    const nextAnswers = [...answers];
    nextAnswers[questionIndex] = choiceIndex;
    setAnswers(nextAnswers);
    if (nextAnswers.every((answer) => answer !== null)) {
      const finalScore = nextAnswers.reduce<number>(
        (total, answer, index) =>
          total + (answer === questions[index].correctIndex ? 1 : 0),
        0,
      );
      void saveProgress(finalScore);
    }
  }

  return (
    <section className="quiz-card" aria-labelledby="quiz-heading">
      <h2 id="quiz-heading">Check your understanding</h2>
      <p className="quiz-intro">Choose one answer for each question. You’ll get feedback right away.</p>
      {questions.map((question, questionIndex) => {
        const selected = answers[questionIndex];
        const isCorrect = selected === question.correctIndex;
        return (
          <fieldset className="question-card" key={question.prompt}>
            <legend className="question-prompt">
              {questionIndex + 1}. {question.prompt}
            </legend>
            <div className="choices">
              {question.choices.map((choice, choiceIndex) => {
                const isSelected = selected === choiceIndex;
                return (
                  <button
                    type="button"
                    className={`choice ${isSelected ? `selected ${isCorrect ? "correct" : "incorrect"}` : ""}`}
                    key={choice}
                    onClick={() => choose(questionIndex, choiceIndex)}
                    disabled={selected !== null}
                    aria-pressed={isSelected}
                  >
                    {choice}
                  </button>
                );
              })}
            </div>
            {selected !== null && (
              <p className={`answer-feedback ${isCorrect ? "" : "incorrect"}`} role="status">
                <strong>{isCorrect ? "Correct." : "Not quite."}</strong>{" "}
                {question.explanations[selected]}
              </p>
            )}
          </fieldset>
        );
      })}
      {answeredAll && (
        <div className="quiz-result" aria-live="polite">
          <strong>You scored {score} out of {questions.length}.</strong>
          <p>
            {saveStatus === "saving" && "Saving your progress…"}
            {saveStatus === "saved" && "Lesson complete. Your progress is saved."}
            {saveStatus === "failed" && "Your score is shown, but progress could not be saved. Refresh and try the quiz again."}
          </p>
        </div>
      )}
    </section>
  );
}
