import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/db";
import { courses } from "@/db/schema";
import { regenerateOutline } from "@/lib/generate";

export const runtime = "nodejs";

const regenerateRequest = z.object({
  feedback: z.string().trim().min(1),
});

function errorMessage(error: unknown) {
  return error instanceof Error
    ? error.message
    : "Could not regenerate the outline.";
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const { feedback } = regenerateRequest.parse(await request.json());
    const course = await db.query.courses.findFirst({
      where: eq(courses.id, id),
    });
    if (!course) {
      return NextResponse.json({ error: "Course not found." }, { status: 404 });
    }
    if (course.status !== "outline_review") {
      return NextResponse.json(
        { error: "This outline is not awaiting feedback." },
        { status: 409 },
      );
    }

    db.update(courses)
      .set({ status: "outlining", error: null })
      .where(eq(courses.id, id))
      .run();
    void regenerateOutline(id, feedback).catch((error) => {
      db.update(courses)
        .set({ status: "failed", error: errorMessage(error) })
        .where(eq(courses.id, id))
        .run();
    });

    return NextResponse.json({ status: "outlining" }, { status: 202 });
  } catch (error) {
    const message =
      error instanceof z.ZodError
        ? error.issues[0]?.message ?? "Outline feedback is required."
        : errorMessage(error);
    return NextResponse.json(
      { error: message },
      { status: error instanceof z.ZodError ? 400 : 502 },
    );
  }
}
