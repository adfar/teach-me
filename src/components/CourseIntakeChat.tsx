"use client";

import { FormEvent, KeyboardEvent, useState } from "react";
import { useRouter } from "next/navigation";
import type { IntakeMessageV1 } from "@/lib/course-schema";

export function CourseIntakeChat({
  courseId,
  initialMessages,
}: {
  courseId: string;
  initialMessages: IntakeMessageV1[];
}) {
  const router = useRouter();
  const [messages, setMessages] = useState(initialMessages);
  const [draft, setDraft] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function sendMessage(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const message = draft.trim();
    if (!message || submitting) return;

    setMessages((current) => [...current, { role: "user", content: message }]);
    setDraft("");
    setSubmitting(true);
    setError(null);

    try {
      const response = await fetch(`/api/courses/${courseId}/intake`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message }),
      });
      const result: {
        status?: "intake" | "outlining";
        conversation?: { messages: IntakeMessageV1[] };
        error?: string;
      } = await response.json();
      if (!response.ok || !result.conversation) {
        throw new Error(result.error ?? "Could not continue the conversation.");
      }

      setMessages(result.conversation.messages);
      if (result.status === "outlining") {
        router.push(`/courses/${courseId}`);
        return;
      }
    } catch (caught) {
      setMessages((current) => current.slice(0, -1));
      setDraft(message);
      setError(
        caught instanceof Error
          ? caught.message
          : "Could not continue the conversation.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  function submitOnEnter(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      event.currentTarget.form?.requestSubmit();
    }
  }

  return (
    <section className="intake-chat" aria-label="Course planning conversation">
      <div className="intake-messages" aria-live="polite">
        {messages.map((message, index) => (
          <div
            className={`intake-message intake-message-${message.role}`}
            key={`${message.role}-${index}`}
          >
            <span>{message.role === "assistant" ? "Course designer" : "You"}</span>
            <p>{message.content}</p>
          </div>
        ))}
        {submitting && (
          <div className="intake-message intake-message-assistant intake-message-thinking">
            <span>Course designer</span>
            <p><span className="spinner" aria-hidden="true" /> Thinking…</p>
          </div>
        )}
      </div>

      <form className="intake-composer" onSubmit={sendMessage}>
        <label className="sr-only" htmlFor="intake-message">
          Your reply
        </label>
        <textarea
          id="intake-message"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={submitOnEnter}
          placeholder="Tell me what you have in mind…"
          rows={3}
          maxLength={2_000}
          disabled={submitting}
          autoFocus
        />
        <button
          className="button"
          type="submit"
          disabled={submitting || !draft.trim()}
        >
          Send
        </button>
      </form>
      <p className={`form-note ${error ? "error-text" : ""}`} role="status">
        {error ?? "A couple of messages is usually enough. Enter sends; Shift+Enter adds a line."}
      </p>
    </section>
  );
}
