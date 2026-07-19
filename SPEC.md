# teach-me — Phase 1 Specification

An AI-powered learning web app. The user types a topic ("teach me linear algebra"),
the app generates a complete structured course via the Claude API, archives it in a
local SQLite database, and renders it from the archive from then on. Generation
happens once per course; reading is instant and free.

This spec is the contract for phase 1. Where it prescribes exact API shapes
(especially Anthropic SDK usage), follow them exactly — they reflect the current
API, which has breaking changes newer than most training data.

---

## 1. Stack

- **Next.js 15+ (App Router) + TypeScript**, `create-next-app` defaults (ESLint, Tailwind CSS, `src/` dir, `@/*` alias)
- **Drizzle ORM + better-sqlite3** — DB file at `./data/teach-me.db` (gitignore `data/`)
- **Zod** for the course schema (single source of truth for both generation and rendering types)
- **@anthropic-ai/sdk** (latest) for generation
- `ANTHROPIC_API_KEY` read from `.env.local` (gitignored). Ship a `.env.example` with the variable name. All Anthropic calls happen server-side only.
- Markdown rendering: `react-markdown` + `remark-gfm`

## 2. The course framework — `CourseV1`

Define in `src/lib/course-schema.ts`. This versioned Zod schema is the canonical
shape of every course. All TypeScript types derive from it via `z.infer`.

```
CourseV1
├─ schemaVersion: literal 1
├─ title: string
├─ topic: string                    // the user's original request
├─ description: string              // 2–3 sentence overview
├─ difficulty: "beginner" | "intermediate" | "advanced"
├─ prerequisites: string[]          // may be empty
└─ modules: Module[]                // 3–6
   ├─ title: string
   ├─ objective: string             // what the learner can do after this module
   └─ lessons: LessonOutline[]      // 2–5
      ├─ title: string
      └─ summary: string            // 1–2 sentences; guides full-lesson generation
```

Lesson content (generated separately, per lesson):

```
LessonContentV1
├─ schemaVersion: literal 1
└─ blocks: Block[]                  // ordered; discriminated union on "type"
   ├─ { type: "explanation", markdown: string }
   ├─ { type: "example", title: string, markdown: string }
   ├─ { type: "callout", variant: "tip" | "warning" | "analogy", markdown: string }
   └─ { type: "quiz", questions: QuizQuestion[] }   // 2–4 questions
        QuizQuestion:
        ├─ prompt: string
        ├─ choices: string[]                        // exactly 4
        ├─ correctIndex: integer 0–3
        └─ explanations: string[]                   // exactly 4, one per choice,
                                                    // explaining why right/wrong
```

Every lesson must contain at least one `explanation`, at least one `example`, and
exactly one `quiz` as the final block. Enforce with a Zod `superRefine` after
parsing (structured outputs guarantee the shape; the refinement guards ordering
and counts the schema can't express — note the API schema itself must not use
min/max constraints, see §4).

## 3. Database schema (Drizzle, `src/db/schema.ts`)

```
courses
  id            text pk (nanoid/uuid)
  topic         text not null
  title         text
  description   text
  difficulty    text
  prerequisites text (JSON array)
  schemaVersion integer not null default 1
  status        text not null      // "generating" | "ready" | "failed"
  error         text               // populated when status = "failed"
  createdAt     integer (epoch ms)

modules
  id        text pk
  courseId  text fk -> courses (cascade delete)
  position  integer not null
  title     text not null
  objective text not null

lessons
  id        text pk
  moduleId  text fk -> modules (cascade delete)
  position  integer not null
  title     text not null
  summary   text not null
  status    text not null          // "pending" | "generating" | "ready" | "failed"
  content   text                   // JSON LessonContentV1 when ready
  error     text

progress
  lessonId    text pk fk -> lessons (cascade delete)
  completedAt integer               // set when the lesson is marked done
  quizScore   integer               // correct answers on most recent attempt
  quizTotal   integer
```

Migrations via `drizzle-kit`; run automatically on app start (or `push` in a
predev script) so `npm run dev` works from a fresh clone with zero manual steps.

## 4. Generation pipeline (`src/lib/generate.ts`)

Two-pass design. **Pass 1** creates the course outline; **pass 2** fills in each
lesson with the outline as context so lessons don't overlap or contradict.

### Anthropic SDK usage — follow exactly (current API; training priors are stale)

- Model: **`claude-opus-4-8`** for both passes.
- Use structured outputs via **`client.messages.parse`** with
  `output_config: { format: zodOutputFormat(Schema) }` where `zodOutputFormat`
  comes from `@anthropic-ai/sdk/helpers/zod`. Read the result from
  `response.parsed_output` (nullable — treat null as a retryable failure).
- Set `thinking: { type: "adaptive" }` explicitly (it is NOT on by default on
  Opus 4.8; do not use `budget_tokens` — it returns a 400).
- **Do not pass `temperature`, `top_p`, or `top_k`** — all three return a 400 on
  Opus 4.8.
- Do not use assistant-message prefills — they return a 400.
- `max_tokens: 16000` for both passes (a single lesson or outline fits well
  within this; stays under SDK HTTP-timeout thresholds without streaming).
- Structured-output JSON schemas do not support numeric/length constraints
  (`minItems`, `minimum`, etc.) — the Python/TS SDKs strip them and validate
  client-side, which is fine, but express hard requirements (counts, ordering)
  in the **prompt text** and verify with the `superRefine` from §2.
- Wrap calls with retry: on `RateLimitError` or `InternalServerError`
  (`instanceof` checks from the SDK, not message matching) retry up to 2 times
  with exponential backoff; the SDK's built-in retries handle the rest.

### Pass 1 — outline

One `messages.parse` call. System prompt establishes the app's teaching
philosophy (clear explanations, concrete examples, build concepts in dependency
order). User message contains the topic. Output: `CourseV1` (with lesson
outlines only). Persist the course + modules + lessons rows (`status: "pending"`)
before starting pass 2.

### Pass 2 — lessons

For each lesson, one `messages.parse` call producing `LessonContentV1`. The
prompt includes: course title/description/difficulty, the full outline (module
and lesson titles + summaries) so the model knows what is covered elsewhere,
which lessons precede this one, and this lesson's title + summary. Instruct it
explicitly: markdown prose, at least one worked example, exactly one quiz as the
final block with 4 choices and 4 per-choice explanations per question, 2–4
questions.

- Run with a **concurrency limit of 3** (simple semaphore; no new dependency
  needed).
- Update each lesson row to `generating` → `ready` (with content JSON) or
  `failed` (with error message) as it completes.
- When all lessons are terminal: course `status` = `ready` if all lessons are
  ready, else `failed` (but keep successfully generated lessons).

### Kickoff and progress

- `POST /api/courses` `{ topic }` → runs pass 1 **awaited** (so validation
  errors surface in the response), inserts rows, kicks off pass 2 **without
  awaiting** (fire-and-forget promise; fine in a long-lived local Node server),
  and returns `{ courseId }` immediately after the outline exists.
- `GET /api/courses/:id` → course + modules + lesson rows (status, no content) —
  the create page polls this every ~1.5s to render live progress.
- `POST /api/lessons/:id/retry` → regenerates a single `failed` lesson.

## 5. Routes and pages

| Route | Purpose |
|---|---|
| `/` | Course library: grid of course cards (title, difficulty, module count, per-course progress %, status badge for generating/failed). Prominent "Teach me…" input that POSTs to `/api/courses` and navigates to the course page. Empty state invites the first topic. |
| `/courses/[id]` | Course overview: description, prerequisites, module list with lesson links and per-lesson status/progress. While `status = "generating"`, polls and shows a live checklist of lessons filling in (spinner → check). Failed lessons show a retry button. |
| `/courses/[id]/lessons/[lessonId]` | Lesson reader: renders the block sequence (markdown via react-markdown; callout variants visually distinct; examples in a bordered card). Quiz is interactive: pick an answer per question → immediate right/wrong + the explanation for the chosen answer → after all questions answered, show score, persist to `progress` (via `POST /api/lessons/:id/progress`), and mark the lesson complete. Prev/next lesson navigation across module boundaries. |

Additional API routes as needed for progress writes and lesson content reads.
Server components for reads where natural; client components for the poller,
quiz, and creation flow.

## 6. Quality bar

- `npm run build` and `npm run lint` pass clean.
- Zero manual setup beyond `npm install` + adding `ANTHROPIC_API_KEY` to
  `.env.local` (DB file and migrations auto-created).
- No Anthropic key or SDK import reachable from client components.
- All course/lesson JSON parsed through the Zod schemas at the read boundary
  (`JSON.parse` output is validated, not cast).
- Errors are first-class: a failed generation shows what failed and offers
  retry; it never leaves the UI stuck on a spinner.
- Clean, readable UI. Simple and typographically calm beats flashy: generous
  line length limits for reading (~70ch), clear hierarchy, dark-mode support
  via Tailwind defaults. No component library needed.

## 7. Out of scope for phase 1

Auth/accounts, sharing, course editing, spaced repetition, export, streaming
token-by-token lesson display, non-English content, deployment config.
