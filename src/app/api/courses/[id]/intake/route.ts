import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";
import { db } from "@/db";
import { courses } from "@/db/schema";
import { IntakeQuestionsV1 } from "@/lib/course-schema";
import { submitIntakeAnswers } from "@/lib/generate";

export const runtime = "nodejs";

const submittedAnswer = z.object({
  questionId: z.string().min(1),
  answer: z.union([z.string(), z.array(z.string())]),
});

const intakeRequest = z.object({
  answers: z.array(submittedAnswer),
});

function errorMessage(error: unknown) {
  return error instanceof Error
    ? error.message
    : "Could not create the course outline.";
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params;
    const course = await db.query.courses.findFirst({
      where: eq(courses.id, id),
    });
    if (!course) {
      return NextResponse.json({ error: "Course not found." }, { status: 404 });
    }
    if (course.status !== "intake") {
      return NextResponse.json(
        { error: "This course intake has already been submitted." },
        { status: 409 },
      );
    }
    if (!course.intakeQuestions) {
      throw new Error("This course does not have intake questions.");
    }

    const intakeQuestions = IntakeQuestionsV1.parse(
      JSON.parse(course.intakeQuestions),
    );
    const storedById = new Map(
      intakeQuestions.questions.map((question) => [question.id, question]),
    );
    const schema = intakeRequest.superRefine(({ answers }, context) => {
      const suppliedIds = new Set(answers.map(({ questionId }) => questionId));
      if (
        suppliedIds.size !== answers.length ||
        answers.length !== intakeQuestions.questions.length
      ) {
        context.addIssue({
          code: "custom",
          path: ["answers"],
          message: "Submit exactly one answer for every intake question.",
        });
      }

      answers.forEach((answer, index) => {
        const question = storedById.get(answer.questionId);
        if (!question) {
          context.addIssue({
            code: "custom",
            path: ["answers", index, "questionId"],
            message: "Unknown intake question.",
          });
          return;
        }

        if (question.kind === "multi") {
          if (!Array.isArray(answer.answer) || answer.answer.length === 0) {
            context.addIssue({
              code: "custom",
              path: ["answers", index, "answer"],
              message: "Choose at least one answer.",
            });
          } else if (
            answer.answer.some((choice) => !question.options.includes(choice))
          ) {
            context.addIssue({
              code: "custom",
              path: ["answers", index, "answer"],
              message: "Choose only the available options.",
            });
          }
          return;
        }

        if (Array.isArray(answer.answer)) {
          context.addIssue({
            code: "custom",
            path: ["answers", index, "answer"],
            message: "Choose one answer.",
          });
        } else if (
          question.kind === "single" &&
          !question.options.includes(answer.answer)
        ) {
          context.addIssue({
            code: "custom",
            path: ["answers", index, "answer"],
            message: "Choose one of the available options.",
          });
        }
      });
    });
    const { answers } = schema.parse(await request.json());
    const normalizedAnswers = intakeQuestions.questions.map((question) => {
      const answer = answers.find((item) => item.questionId === question.id);
      if (!answer) throw new Error(`Missing answer for ${question.id}.`);
      return {
        questionId: question.id,
        question: question.question,
        answer: answer.answer,
      };
    });

    db.update(courses)
      .set({ status: "outlining", error: null })
      .where(eq(courses.id, id))
      .run();

    void submitIntakeAnswers(id, normalizedAnswers).catch((error) => {
      db.update(courses)
        .set({ status: "failed", error: errorMessage(error) })
        .where(eq(courses.id, id))
        .run();
    });

    return NextResponse.json({ status: "outlining" }, { status: 202 });
  } catch (error) {
    const message =
      error instanceof z.ZodError
        ? error.issues[0]?.message ?? "Invalid intake answers."
        : errorMessage(error);
    return NextResponse.json(
      { error: message },
      { status: error instanceof z.ZodError ? 400 : 502 },
    );
  }
}
