import Link from "next/link";
import { listCourseDetails } from "@/db/queries";
import { CreateCourseForm } from "@/components/CreateCourseForm";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default async function Home() {
  const courseDetails = await listCourseDetails();

  return (
    <div className="page-shell">
      <section className="hero">
        <p className="eyebrow">Your learning library</p>
        <h1>What do you want to understand?</h1>
        <p className="hero-copy">
          Name a topic. We’ll shape it into a structured course with focused lessons,
          worked examples, and quizzes—then keep it here whenever you want to return.
        </p>
        <CreateCourseForm />
      </section>

      {courseDetails.length ? (
        <section aria-labelledby="courses-heading">
          <div className="section-heading">
            <h2 id="courses-heading">Your courses</h2>
            <span className="badge">{courseDetails.length} total</span>
          </div>
          <div className="course-grid">
            {courseDetails.map(({ course, modules }) => {
              const allLessons = modules.flatMap((courseModule) => courseModule.lessons);
              const completed = allLessons.filter((lesson) => lesson.progress?.completedAt).length;
              const percent = allLessons.length ? Math.round((completed / allLessons.length) * 100) : 0;
              return (
                <Link className="course-card" href={`/courses/${course.id}`} key={course.id}>
                  <div className="card-topline">
                    <span className="badge">{course.difficulty ?? "course"}</span>
                    <span className={`badge badge-${course.status}`}>{course.status}</span>
                  </div>
                  <h3>{course.title ?? course.topic}</h3>
                  <p>{modules.length} modules · {allLessons.length} lessons</p>
                  <div className="card-footer">
                    <div className="progress-label">
                      <span>{completed} lessons complete</span><span>{percent}%</span>
                    </div>
                    <div className="progress-track" aria-label={`${percent}% complete`}>
                      <div className="progress-bar" style={{ width: `${percent}%` }} />
                    </div>
                  </div>
                </Link>
              );
            })}
          </div>
        </section>
      ) : (
        <section className="empty-state">
          <h2>Your first course starts with a question.</h2>
          <p>Try “Teach me how neural networks learn” or any topic you’re curious about.</p>
        </section>
      )}
    </div>
  );
}
