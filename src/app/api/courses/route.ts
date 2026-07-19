import { NextResponse } from "next/server";
import { z } from "zod";
import {
  createCourseOutline,
  failUnresolvedLessons,
  generateCourseLessons,
} from "@/lib/generate";

export const runtime = "nodejs";

const createCourseRequest = z.object({
  topic: z.string().trim().min(2).max(200),
});

export async function POST(request: Request) {
  try {
    const body: unknown = await request.json();
    const { topic } = createCourseRequest.parse(body);
    const courseId = await createCourseOutline(topic);

    void generateCourseLessons(courseId).catch((error) =>
      failUnresolvedLessons(courseId, error).catch(() => undefined),
    );

    return NextResponse.json({ courseId }, { status: 201 });
  } catch (error) {
    const message =
      error instanceof z.ZodError
        ? error.issues[0]?.message ?? "Invalid topic."
        : error instanceof Error
          ? error.message
          : "Could not create the course.";
    return NextResponse.json(
      { error: message },
      { status: error instanceof z.ZodError ? 400 : 502 },
    );
  }
}
