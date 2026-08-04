import { NextResponse } from "next/server";
import { generateLessonById } from "@/lib/generate";

export const runtime = "nodejs";

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const started = await generateLessonById(id);
    return NextResponse.json({ started });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : "Could not generate lesson.",
      },
      { status: 502 },
    );
  }
}
