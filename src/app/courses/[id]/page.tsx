import Link from "next/link";
import { notFound } from "next/navigation";
import { CourseOverview } from "@/components/CourseOverview";
import { getCourseDetail } from "@/db/queries";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function CoursePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const detail = await getCourseDetail(id);
  if (!detail) notFound();

  return (
    <div className="page-shell">
      <Link className="back-link" href="/">← Library</Link>
      <CourseOverview initialDetail={detail} />
    </div>
  );
}
