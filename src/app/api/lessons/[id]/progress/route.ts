import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/db";
import { parseLessonContent } from "@/db/queries";
import { lessons, progress } from "@/db/schema";

export const runtime = "nodejs";

const progressRequest = z
  .object({
    quizScore: z.number().int().min(0),
    quizTotal: z.number().int().positive(),
  })
  .refine((value) => value.quizScore <= value.quizTotal, {
    message: "Quiz score cannot exceed quiz total.",
  });

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const payload = progressRequest.parse(await request.json());
    const lesson = await db.query.lessons.findFirst({
      where: eq(lessons.id, id),
    });
    if (!lesson || lesson.status !== "ready") {
      return NextResponse.json({ error: "Ready lesson not found." }, { status: 404 });
    }

    const content = parseLessonContent(lesson.content);
    const quiz = content.blocks.find((block) => block.type === "quiz");
    if (!quiz || quiz.questions.length !== payload.quizTotal) {
      return NextResponse.json({ error: "Quiz total does not match." }, { status: 400 });
    }

    const completedAt = Date.now();
    await db
      .insert(progress)
      .values({ lessonId: id, completedAt, ...payload })
      .onConflictDoUpdate({
        target: progress.lessonId,
        set: { completedAt, ...payload },
      });
    return NextResponse.json({ completedAt });
  } catch (error) {
    const message =
      error instanceof z.ZodError
        ? error.issues[0]?.message ?? "Invalid progress."
        : error instanceof Error
          ? error.message
          : "Could not save progress.";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
