import { NextResponse } from "next/server";
import { retryFailedLesson } from "@/lib/generate";

export const runtime = "nodejs";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const ready = await retryFailedLesson(id);
    return NextResponse.json({ status: ready ? "ready" : "failed" });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : "Retry failed." },
      { status: 400 },
    );
  }
}
