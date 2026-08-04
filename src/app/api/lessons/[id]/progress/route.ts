import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/db";
import { parseLessonContent } from "@/db/queries";
import { lessons, progress } from "@/db/schema";

export const runtime = "nodejs";

const scoreProgressRequest = z
  .object({
    action: z.literal("saveScore"),
    quizScore: z.number().int().min(0),
    quizTotal: z.number().int().positive(),
  })
  .refine((value) => value.quizScore <= value.quizTotal, {
    message: "Quiz score cannot exceed quiz total.",
  });

const completionProgressRequest = z.object({
  action: z.literal("setCompletion"),
  completed: z.boolean(),
});

const progressRequest = z.union([
  scoreProgressRequest,
  completionProgressRequest,
]);

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

    if (payload.action === "saveScore") {
      const content = parseLessonContent(lesson.content);
      const quiz =
        content.schemaVersion === 1
          ? content.blocks.find((block) => block.type === "quiz")
          : content.quiz;
      if (!quiz || quiz.questions.length !== payload.quizTotal) {
        return NextResponse.json(
          { error: "Quiz total does not match." },
          { status: 400 },
        );
      }

      await db
        .insert(progress)
        .values({
          lessonId: id,
          quizScore: payload.quizScore,
          quizTotal: payload.quizTotal,
        })
        .onConflictDoUpdate({
          target: progress.lessonId,
          set: {
            quizScore: payload.quizScore,
            quizTotal: payload.quizTotal,
          },
        });
      return NextResponse.json({
        quizScore: payload.quizScore,
        quizTotal: payload.quizTotal,
      });
    }

    const completedAt = payload.completed ? Date.now() : null;
    await db
      .insert(progress)
      .values({ lessonId: id, completedAt })
      .onConflictDoUpdate({
        target: progress.lessonId,
        set: { completedAt },
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
