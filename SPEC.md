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

- Model: **`claude-opus-5`** for both passes.
- Use structured outputs via **`client.messages.parse`** with
  `output_config: { format: zodOutputFormat(Schema) }` where `zodOutputFormat`
  comes from `@anthropic-ai/sdk/helpers/zod`. Read the result from
  `response.parsed_output` (nullable — treat null as a retryable failure).
- Set `thinking: { type: "adaptive" }` explicitly; do not use `budget_tokens`
  (returns a 400). Note: on Opus 5, thinking is on by default even without
  this field — the explicit setting is equivalent, so it's kept for clarity
  and to pin behavior if the default ever changes.
- **Do not pass `temperature`, `top_p`, or `top_k`** — all three return a 400 on
  Opus models.
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

---

## 8. Phase 2 — Fable 5 migration

Generation model changes from `claude-opus-5` to **`claude-fable-5`** for both
passes (outline + lesson). This is not a pure constant swap — Fable 5 changes
one piece of API behavior that the current retry logic doesn't account for.

### What changes

- `MODEL = "claude-fable-5"` in `src/lib/generate.ts`.
- `thinking: { type: "adaptive" }` stays as-is — Fable 5 has thinking
  permanently on (`{"type": "disabled"}` is rejected), and the adaptive form
  remains valid and equivalent, so no code change needed here.
- **Refusals are a new failure mode.** On Fable 5, a declined request comes
  back as a normal 200 response with `stop_reason: "refusal"`, not an
  exception — this is different from Opus, where nothing in this pipeline
  currently distinguishes a refusal from "the model emitted nothing parseable."
  Confirm the exact field(s) that carry the refusal/classifier detail against
  the installed `@anthropic-ai/sdk` TypeScript types before implementing (the
  docs describe the behavior but not the precise wire shape, and training
  priors for this are stale — do not guess the field name).
- In `withGenerationRetry` (or the call sites in `requestOutline` /
  `generateLesson`), detect `stop_reason === "refusal"` and treat it as a
  **non-retryable** failure with a distinct, clearly labeled error message
  (e.g. `Content declined by safety classifier` plus whatever detail the SDK
  exposes). Retrying a refusal on the same input wastes calls for no benefit —
  don't fold it into the existing "parsed_output was null, retry" path.
- This surfaces through the existing `lessons.error` / `courses.error` columns
  and retry UI unchanged — no schema change needed for this part.
- No live end-to-end test has been run yet against `claude-fable-5` (blocked
  on API credits during phase 1 testing) — validate with a real course
  generation once credits are available, specifically watching for: the
  refusal path (hard to trigger deliberately for this content domain, so at
  minimum confirm the code path type-checks and the non-refusal path works),
  and total generation latency/cost versus Opus 5 (Fable 5 is priced higher
  per token: $10/$50 per MTok vs $5/$25 for Opus 5).

## 9. Phase 2 — Automated quality/consistency review

Structural validation (Zod, §2) guarantees shape but not content quality:
nothing today checks factual accuracy, whether a lesson stayed in its assigned
scope, cross-lesson overlap, or whether a quiz's `correctIndex` and
per-choice `explanations` are actually correct. This adds an automated judge
pass that catches those issues and surfaces them — advisory, not blocking.

### Judge schema — `LessonReviewV1` (new, in `course-schema.ts`)

```
LessonReviewV1
├─ passed: boolean
└─ issues: Issue[]                  // empty when passed
   ├─ category: "accuracy" | "scope" | "overlap" | "quiz"
   ├─ severity: "minor" | "major"
   └─ description: string           // specific, references the block/claim
```

No `superRefine` needed — this schema has no cross-field invariants beyond
what Zod already expresses.

### Pipeline change — `generate.ts`

- After a lesson passes `LessonContentV1.parse` (i.e., structurally valid),
  before marking it `ready`, call a new `reviewLesson()`:
  - **Model: `claude-sonnet-5`** — a cheaper/faster model is appropriate here;
    this is a secondary check, not primary generation, and doubling every
    lesson's cost on the primary model isn't justified.
  - Context passed in: the full lesson content, the course title/description,
    and the **outline only** (all module/lesson titles + summaries) rather
    than every other lesson's full content — enough to judge scope and
    overlap without an expensive full-course context dump.
  - Ask it to check: factual accuracy of explanation/example claims, whether
    content stayed within the assigned lesson's scope (vs. the summary and
    what other lessons in the outline already own), whether quiz
    `correctIndex` values are actually correct and whether each of the 4
    `explanations` truthfully explains why its choice is right or wrong.
  - Output via `messages.parse` + `zodOutputFormat(LessonReviewV1)`, same
    pattern as the rest of the pipeline.
- **Review is best-effort and advisory, never blocking:** if the review call
  itself fails (rate limit, network, refusal, etc.), catch it, leave
  `reviewStatus` / `reviewNotes` as `null`, and still mark the lesson `ready`.
  A lesson that passed structural validation should never be held back by a
  secondary check failing to run.
- If review completes: set `reviewStatus` to `"passed"` or `"flagged"`, and
  `reviewNotes` to `JSON.stringify(issues)` (null when passed).

### Schema change — `lessons` table

Add two nullable columns:
```
reviewStatus  text     // "passed" | "flagged" | null (null = not yet reviewed, or review skipped)
reviewNotes   text      // JSON Issue[] , null unless flagged
```
Migrate via `drizzle-kit generate`; no backfill needed for existing rows (they
stay `null`, meaning "unreviewed" — the UI should treat `null` the same as
`"passed"` visually, i.e. no badge, since it's not a known problem).

### Retry behavior

Extend the existing `retryFailedLesson` (or add a sibling) so a **flagged**
lesson can be regenerated the same way a **failed** one can — reuse the retry
endpoint/button rather than adding a new UI affordance. When retrying a
flagged lesson, include the prior `issues` in the regeneration prompt as
specific things to fix, and reset `reviewStatus`/`reviewNotes` to `null`
before the new attempt (it gets reviewed again like any fresh generation).

### UI change

- `CourseOverview.tsx`: lessons with `reviewStatus === "flagged"` show a small
  indicator (e.g. a warning badge) alongside the existing status display.
- Lesson reader page: if the current lesson is flagged, show a dismissible
  banner listing the issues (category + description) with a "Regenerate this
  lesson" action wired to the retry endpoint.
- No indicator for `null` or `"passed"` — don't clutter the UI with a
  judge-approved badge on every lesson; only surface the exception.

### Out of scope for this pass

Course-level or cross-course consistency checks beyond a single lesson's
outline context; blocking/auto-regenerating without user action; a review
score/number (issues are qualitative, not scored); re-reviewing lessons that
already passed when sibling lessons change.
