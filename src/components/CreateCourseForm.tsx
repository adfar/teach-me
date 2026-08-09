"use client";

import { FormEvent, useState } from "react";
import { useRouter } from "next/navigation";

export function CreateCourseForm() {
  const router = useRouter();
  const [topic, setTopic] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const response = await fetch("/api/courses", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ topic }),
      });
      const result: { courseId?: string; error?: string } = await response.json();
      if (!response.ok || !result.courseId) {
        throw new Error(result.error ?? "Could not create that course.");
      }
      router.push(`/courses/${result.courseId}/intake`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Could not create that course.");
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={submit}>
      <div className="create-form">
        <label className="sr-only" htmlFor="topic">What would you like to learn?</label>
        <input
          className="create-input"
          id="topic"
          name="topic"
          placeholder="Teach me linear algebra…"
          value={topic}
          onChange={(event) => setTopic(event.target.value)}
          minLength={2}
          maxLength={200}
          disabled={submitting}
          required
          autoComplete="off"
        />
        <button className="button" type="submit" disabled={submitting || topic.trim().length < 2}>
          {submitting ? "Starting…" : "Create course"}
        </button>
      </div>
      <p className={`form-note ${error ? "error-text" : ""}`} role="status">
        {error ??
          (submitting
            ? "Opening a quick conversation with your course designer."
            : "")}
      </p>
    </form>
  );
}
