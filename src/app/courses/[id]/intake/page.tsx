import { eq } from "drizzle-orm";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { CourseIntakeChat } from "@/components/CourseIntakeChat";
import { db } from "@/db";
import { courses } from "@/db/schema";
import { IntakeConversationV1 } from "@/lib/course-schema";
import { initialIntakeConversation } from "@/lib/generate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function CourseIntakePage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const course = await db.query.courses.findFirst({
    where: eq(courses.id, id),
  });
  if (!course) notFound();
  if (course.status !== "intake") redirect(`/courses/${id}`);

  const conversation = course.intakeConversation
    ? IntakeConversationV1.parse(JSON.parse(course.intakeConversation))
    : initialIntakeConversation(course.topic);

  return (
    <main className="reading-shell intake-shell">
      <Link className="back-link" href="/">
        ← Library
      </Link>
      <header className="intake-header">
        <p className="eyebrow">A quick conversation</p>
        <h1>What should this course help you do?</h1>
        <p>
          Chat briefly with the course designer about <strong>{course.topic}</strong>.
          Once it understands your goal and starting point, it will build the
          learning path automatically.
        </p>
      </header>
      <CourseIntakeChat
        courseId={id}
        initialMessages={conversation.messages}
      />
    </main>
  );
}
