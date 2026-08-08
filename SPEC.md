# teach-me — Phase 1 Specification

An AI-powered learning web app. The user types a topic ("teach me linear algebra"),
the app generates a structured course through the locally authenticated Codex CLI,
archives it in a local SQLite database, and renders it from the archive from then
on. Lessons generate on demand; archived reading is instant and free.

This spec is the contract for phase 1. Preserve the structured-output and Zod
validation boundaries described here when changing generation behavior.

---

## 1. Stack

- **Next.js 15+ (App Router) + TypeScript**, `create-next-app` defaults (ESLint, Tailwind CSS, `src/` dir, `@/*` alias)
- **Drizzle ORM + better-sqlite3** — DB file at `./data/teach-me.db` (gitignore `data/`)
- **Zod** for the course schema (single source of truth for both generation and rendering types)
- **Codex CLI** for generation, authenticated locally with `codex login`
- **`gpt-5.6-sol` at `high` reasoning** for intake, outline, lesson, and review calls
- Markdown rendering: `react-markdown` + `remark-gfm`

## 2. The course framework — `CourseV1`

Define in `src/lib/course-schema.ts`. This versioned Zod schema is the canonical
shape of every course. All TypeScript types derive from it via `z.infer`.
Course design and lesson prose must follow [`COURSE_STYLE_GUIDE.md`](./COURSE_STYLE_GUIDE.md).

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
  status        text not null      // "intake" | "outlining" | "generating" | "ready" | "failed"
  error         text               // populated when status = "failed"
  learnerProfile text              // JSON profile synthesized by the intake chat
  intakeConversation text          // JSON persisted conversation
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

### Backend and model usage

- Every generation role uses **`gpt-5.6-sol`** at **`high`** reasoning through
  the locally authenticated Codex CLI. There is no alternate provider or
  role-specific model routing.
- Each call runs ephemerally with a read-only sandbox and receives the system
  prompt, task prompt, and JSON Schema over an isolated structured-output path.
  The final JSON is parsed again with the canonical Zod schema before use.
- Retry transient CLI, network, timeout, overload, and rate-limit failures up to
  two times with exponential backoff. Treat authentication and configuration
  errors as non-retryable and surface a useful action to the user.
- `CODEX_TIMEOUT_MS` controls the per-attempt timeout and defaults to 300000.

### Pass 1 — conversation and outline

Creating a course stores the topic immediately and opens a short conversational
intake. Each turn asks at most one adaptive follow-up, and the intake ends as
soon as the desired capability, relevant background, and material constraints
are clear (three learner replies maximum). The final turn returns the compact
learner profile. One outline call then produces `CourseV1`; persist its modules
and pending lessons and start the first lesson automatically. There is no survey
or outline-approval step.

### Pass 2 — lessons

For each lesson, one structured generation call produces `LessonContentV4` in
full. The prompt includes course title/description/difficulty, the outline,
the compact learner profile, the concept ledger from ready preceding lessons,
and the target module/lesson. Generate 3–4 substantive sections with worked
examples and exercises, plus the glossary and final quiz, in that same call.
Do not build sections through separate calls or resend previously generated
section text: that creates quadratic prompt growth and quickly exhausts token
limits. An independent advisory review may follow.
V4 adds structured chart, diagram, and geographic-map blocks plus visual-aware
exercise and quiz references. Maps render against packaged world/U.S. atlas data;
charts and diagrams render from validated structured data. `LessonContentV1`,
`LessonContentV2`, and `LessonContentV3` remain readable for archived courses.

- Generate lessons on demand. Start the first lesson after outline design, warm
  the next lesson when the learner opens one, and allow explicit lesson/unit
  generation from the overview.
- Update each generated lesson row to `generating` → `ready` (with content JSON)
  or `failed` (with error message) as it completes.
- When all lessons are terminal: course `status` = `ready` if all lessons are
  ready, else `failed` (but keep successfully generated lessons).

### Kickoff and progress

- `POST /api/courses` `{ topic }` → stores an intake course immediately and
  returns `{ courseId }`.
- `POST /api/courses/:id/intake` `{ message }` → advances the short chat. Once
  ready, it starts outline design and first-lesson generation without awaiting.
- `GET /api/courses/:id` → course + modules + lesson rows (status, no content) —
  the overview polls this every ~1.5s while outline or lesson work is active.
- `POST /api/lessons/:id/retry` → regenerates a single `failed` lesson.

## 5. Routes and pages

| Route | Purpose |
|---|---|
| `/` | Course library: grid of course cards (title, difficulty, module count, per-course progress %, status badge for generating/failed). Prominent "Teach me…" input that POSTs to `/api/courses` and navigates to the course page. Empty state invites the first topic. |
| `/courses/[id]/intake` | Short conversational intake. One adaptive question at a time; automatically proceeds to course design when enough context is available. |
| `/courses/[id]` | Course overview: description, prerequisites, module list with lesson links and per-lesson status/progress. While `status = "generating"`, polls and shows a live checklist of lessons filling in (spinner → check). Failed lessons show a retry button. |
| `/courses/[id]/lessons/[lessonId]` | Lesson reader: renders the block sequence (markdown via react-markdown; callout variants visually distinct; examples in a bordered card). Quiz is interactive: pick an answer per question → immediate right/wrong + the explanation for the chosen answer → after all questions answered, show score, persist to `progress` (via `POST /api/lessons/:id/progress`), and mark the lesson complete. Prev/next lesson navigation across module boundaries. |

Additional API routes as needed for progress writes and lesson content reads.
Server components for reads where natural; client components for the poller,
quiz, and creation flow.

## 6. Quality bar

- `npm run build` and `npm run lint` pass clean.
- Zero manual setup beyond `npm install` and `codex login` (DB file and
  migrations auto-created).
- No model runtime or credentials are reachable from client components.
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

## 8. Phase 2 — Automated quality/consistency review

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

- After a lesson passes `LessonContentV4.parse` (i.e., structurally valid),
  before marking it `ready`, call a new `reviewLesson()`:
  - **Model: `gpt-5.6-sol` at `high` reasoning**, matching every other
    generation role.
  - Context passed in: the full lesson content, the course title/description,
    and the **outline only** (all module/lesson titles + summaries) rather
    than every other lesson's full content — enough to judge scope and
    overlap without an expensive full-course context dump.
  - Ask it to check: factual accuracy of explanation/example claims, whether
    content stayed within the assigned lesson's scope (vs. the summary and
    what other lessons in the outline already own), whether quiz
    `correctIndex` values are actually correct and whether each of the 4
    `explanations` truthfully explains why its choice is right or wrong.
  - Output through the Codex CLI with the `LessonReviewV1` JSON Schema, then
    validate the result with Zod like the rest of the pipeline.
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
