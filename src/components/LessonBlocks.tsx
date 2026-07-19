import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { LessonContentV1 } from "@/lib/course-schema";
import { Quiz } from "./Quiz";

function Markdown({ children }: { children: string }) {
  return (
    <div className="markdown">
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{children}</ReactMarkdown>
    </div>
  );
}

export function LessonBlocks({ lessonId, content }: { lessonId: string; content: LessonContentV1 }) {
  return (
    <div className="lesson-blocks">
      {content.blocks.map((block, index) => {
        if (block.type === "explanation") {
          return <Markdown key={index}>{block.markdown}</Markdown>;
        }
        if (block.type === "example") {
          return (
            <section className="example-card" key={index}>
              <h2>Worked example · {block.title}</h2>
              <Markdown>{block.markdown}</Markdown>
            </section>
          );
        }
        if (block.type === "callout") {
          return (
            <aside className={`callout callout-${block.variant}`} key={index}>
              <h2>{block.variant === "analogy" ? "A useful analogy" : block.variant === "warning" ? "Watch out" : "Tip"}</h2>
              <Markdown>{block.markdown}</Markdown>
            </aside>
          );
        }
        return <Quiz lessonId={lessonId} questions={block.questions} key={index} />;
      })}
    </div>
  );
}
