import { NextResponse } from "next/server";
import {
  failLessonRetry,
  prepareLessonRetry,
  retryFailedLesson,
} from "@/lib/generate";

export const runtime = "nodejs";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const retry = await prepareLessonRetry(id);

    void retryFailedLesson(retry).catch((error) =>
      failLessonRetry(retry, error).catch(() => undefined),
    );

    return NextResponse.json({ status: "generating" }, { status: 202 });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Retry failed." },
      { status: 400 },
    );
  }
}
