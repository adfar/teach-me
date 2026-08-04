import { eq } from "drizzle-orm";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { CourseIntakeForm } from "@/components/CourseIntakeForm";
import { db } from "@/db";
import { courses } from "@/db/schema";
import { IntakeQuestionsV1 } from "@/lib/course-schema";

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
  if (!course || !course.intakeQuestions) notFound();
  if (course.status !== "intake") redirect(`/courses/${id}`);

  const intakeQuestions = IntakeQuestionsV1.parse(
    JSON.parse(course.intakeQuestions),
  );

  return (
    <main className="reading-shell intake-shell">
      <Link className="back-link" href="/">
        ← Library
      </Link>
      <header className="intake-header">
        <p className="eyebrow">Shape your course</p>
        <h1>A few questions about how you want to learn</h1>
        <p>
          Your answers will shape the depth, pacing, examples, and exercises in
          your course about <strong>{course.topic}</strong>.
        </p>
      </header>
      <CourseIntakeForm courseId={id} questions={intakeQuestions.questions} />
    </main>
  );
}
