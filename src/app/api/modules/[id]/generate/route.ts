import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { db } from "@/db";
import { courses, modules } from "@/db/schema";
import { failUnresolvedLessons, generateModuleLessons } from "@/lib/generate";

export const runtime = "nodejs";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const courseModule = await db.query.modules.findFirst({
      where: eq(modules.id, id),
    });
    if (!courseModule) {
      return NextResponse.json({ error: "Course module not found." }, { status: 404 });
    }

    db.update(courses)
      .set({ status: "generating", error: null })
      .where(eq(courses.id, courseModule.courseId))
      .run();
    void generateModuleLessons(id).catch((error) =>
      failUnresolvedLessons(courseModule.courseId, error).catch(() => undefined),
    );

    return NextResponse.json({ status: "generating" }, { status: 202 });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Could not generate module.",
      },
      { status: 502 },
    );
  }
}
