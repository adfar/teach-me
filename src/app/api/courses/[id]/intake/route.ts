import { NextResponse } from "next/server";
import { z } from "zod";
import {
  continueCourseIntake,
  designCourseFromIntake,
} from "@/lib/generate";

export const runtime = "nodejs";

const intakeMessageRequest = z.object({
  message: z.string().trim().min(1).max(2_000),
});

function errorMessage(error: unknown) {
  return error instanceof Error
    ? error.message
    : "Could not continue the course conversation.";
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const { message } = intakeMessageRequest.parse(await request.json());
    const result = await continueCourseIntake(id, message);

    if (result.ready) {
      void designCourseFromIntake(id).catch(() => undefined);
    }

    return NextResponse.json(
      {
        status: result.ready ? "outlining" : "intake",
        conversation: result.conversation,
      },
      { status: result.ready ? 202 : 200 },
    );
  } catch (error) {
    const status =
      error instanceof z.ZodError
        ? 400
        : error instanceof Error && error.message === "Course not found."
          ? 404
          : error instanceof Error &&
              error.message === "This course intake has already finished."
            ? 409
            : 502;
    return NextResponse.json(
      {
        error:
          error instanceof z.ZodError
            ? error.issues[0]?.message ?? "Write a message to continue."
            : errorMessage(error),
      },
      { status },
    );
  }
}
