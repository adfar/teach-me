import Database from "better-sqlite3";

const databasePath = process.argv[2] ?? "data/teach-me.db";
const database = new Database(databasePath);

try {
  const rows = database
    .prepare(
      `SELECT id, review_status AS reviewStatus, review_notes AS reviewNotes
       FROM lessons
       WHERE review_status = 'flagged' AND review_notes IS NOT NULL`,
    )
    .all();
  const minorOnlyLessonIds = rows.flatMap((row) => {
    let issues;
    try {
      issues = JSON.parse(row.reviewNotes);
    } catch {
      throw new Error(`Lesson ${row.id} has invalid review_notes JSON.`);
    }
    if (!Array.isArray(issues)) {
      throw new Error(`Lesson ${row.id} has non-array review_notes.`);
    }
    return issues.length > 0 &&
      issues.every((issue) => issue?.severity === "minor")
      ? [row.id]
      : [];
  });

  const update = database.prepare(
    `UPDATE lessons
     SET review_status = 'passed'
     WHERE id = ? AND review_status = 'flagged'`,
  );
  const recalibrate = database.transaction((lessonIds) =>
    lessonIds.reduce((count, lessonId) => count + update.run(lessonId).changes, 0),
  );
  const changedRows = recalibrate(minorOnlyLessonIds);

  console.log(
    `Recalibrated ${changedRows} minor-only lesson review status${changedRows === 1 ? "" : "es"} in ${databasePath}.`,
  );
} finally {
  database.close();
}
