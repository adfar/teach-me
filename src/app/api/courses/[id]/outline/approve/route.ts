import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/db";
import { courses } from "@/db/schema";
import { approveOutline, failUnresolvedLessons } from "@/lib/generate";

export const runtime = "nodejs";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const course = await db.query.courses.findFirst({
      where: eq(courses.id, id),
    });
    if (!course) {
      return NextResponse.json({ error: "Course not found." }, { status: 404 });
    }
    if (course.status !== "outline_review") {
      return NextResponse.json(
        { error: "This outline is not awaiting approval." },
        { status: 409 },
      );
    }

    db.update(courses)
      .set({ status: "generating", error: null })
      .where(eq(courses.id, id))
      .run();
    void approveOutline(id).catch((error) =>
      failUnresolvedLessons(id, error).catch(() => undefined),
    );

    return NextResponse.json({ status: "generating" }, { status: 202 });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Could not approve outline.",
      },
      { status: 502 },
    );
  }
}
