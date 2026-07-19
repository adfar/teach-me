import { NextResponse } from "next/server";
import { getCourseDetail } from "@/db/queries";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;
  const detail = await getCourseDetail(id);
  if (!detail) {
    return NextResponse.json({ error: "Course not found." }, { status: 404 });
  }
  return NextResponse.json(detail);
}
