import "server-only";

import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

const MODEL = "gpt-5.6-sol";
const REASONING_EFFORT = "high";
const MAX_RETRIES = 2;
const DEFAULT_CODEX_TIMEOUT_MS = 300_000;

class CodexGenerationError extends Error {
  readonly retryable: boolean;

  constructor(message: string, retryable: boolean) {
    super(message);
    this.name = "CodexGenerationError";
    this.retryable = retryable;
  }
}

function sleep(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isAuthenticationErrorMessage(message: string): boolean {
  return /(auth(?:entication|orization)?(?:[_ -]?failed)?|credentials?|not logged in|login|oauth|unauthorized|401)/i.test(
    message,
  );
}

function isTransientErrorMessage(message: string): boolean {
  return /(rate.?limit|overload(?:ed)?|server[ _-]error|internal[ _-]server|timed?[ _-]?out|timeout|network|socket|transport|econnreset|econnrefused|enetwork|process exited|terminated by signal)/i.test(
    message,
  );
}

function codexTimeoutMilliseconds(): number {
  const value = process.env.CODEX_TIMEOUT_MS;
  if (value === undefined) return DEFAULT_CODEX_TIMEOUT_MS;

  const milliseconds = Number(value);
  if (!Number.isFinite(milliseconds) || milliseconds <= 0) {
    throw new CodexGenerationError(
      "CODEX_TIMEOUT_MS must be a positive number of milliseconds.",
      false,
    );
  }
  return milliseconds;
}

function codexDiagnostic(stdout: string, stderr: string): string {
  const diagnostic = [stderr.trim(), stdout.trim()]
    .filter(Boolean)
    .join("\n");
  return diagnostic ? ` Details: ${diagnostic.slice(0, 4_000)}` : "";
}

function codexSpawnError(error: unknown): CodexGenerationError {
  const message = errorMessage(error);
  const code =
    error instanceof Error && "code" in error
      ? String((error as Error & { code?: unknown }).code)
      : null;
  if (code === "ENOENT") {
    return new CodexGenerationError(
      "Codex CLI was not found. Install Codex and ensure `codex` is available on PATH.",
      false,
    );
  }
  return new CodexGenerationError(
    `Codex CLI failed to start. Verify the local Codex installation and PATH. Details: ${message}`,
    false,
  );
}

async function runCodex({
  payload,
  schemaPath,
  outputPath,
  timeoutMilliseconds,
}: {
  payload: string;
  schemaPath: string;
  outputPath: string;
  timeoutMilliseconds: number;
}): Promise<void> {
  const child = spawn(
    "codex",
    [
      "exec",
      "--ignore-user-config",
      "-m",
      MODEL,
      "-c",
      `model_reasoning_effort=${REASONING_EFFORT}`,
      "--ephemeral",
      "--skip-git-repo-check",
      "--sandbox",
      "read-only",
      "--output-schema",
      schemaPath,
      "--output-last-message",
      outputPath,
      "--color",
      "never",
      "-",
    ],
    { shell: false },
  );
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });

  const result = await new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
    timedOut: boolean;
  }>((resolve, reject) => {
    let timedOut = false;
    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMilliseconds);

    child.once("error", (error) => {
      clearTimeout(timeout);
      reject(codexSpawnError(error));
    });
    child.once("close", (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal, timedOut });
    });
    child.stdin.on("error", () => {
      // Process failures are classified from the exit code and diagnostics.
    });
    child.stdin.end(payload);
  });

  const diagnostic = codexDiagnostic(stdout, stderr);
  if (result.timedOut) {
    throw new CodexGenerationError(
      `Codex CLI timed out after ${timeoutMilliseconds}ms and was terminated.${diagnostic}`,
      true,
    );
  }
  if (result.code !== 0) {
    const message = `Codex CLI exited with code ${result.code}${
      result.signal ? ` (signal ${result.signal})` : ""
    }.${diagnostic}`;
    if (isAuthenticationErrorMessage(message)) {
      throw new CodexGenerationError(
        `Codex CLI authentication failed. Run \`codex login\` on this machine and try again.${diagnostic}`,
        false,
      );
    }
    throw new CodexGenerationError(message, true);
  }
}

export async function generateStructured<S extends z.ZodType>({
  system,
  prompt,
  schema,
}: {
  system: string;
  prompt: string;
  schema: S;
}): Promise<z.infer<S>> {
  const identifier = `${process.pid}-${Date.now()}-${randomBytes(12).toString("hex")}`;
  const schemaPath = join(tmpdir(), `teach-me-codex-${identifier}-schema.json`);
  const outputPath = join(tmpdir(), `teach-me-codex-${identifier}-output.json`);
  const timeoutMilliseconds = codexTimeoutMilliseconds();
  const payload = `--- SYSTEM INSTRUCTIONS ---\n${system}\n--- END SYSTEM INSTRUCTIONS ---\n\n--- USER PROMPT ---\n${prompt}\n--- END USER PROMPT ---\n`;

  try {
    await writeFile(
      schemaPath,
      JSON.stringify(z.toJSONSchema(schema, { target: "draft-7" })),
      { flag: "wx" },
    );

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
      try {
        await unlink(outputPath).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== "ENOENT") throw error;
        });
        await runCodex({
          payload,
          schemaPath,
          outputPath,
          timeoutMilliseconds,
        });

        let parsed: unknown;
        try {
          parsed = JSON.parse(await readFile(outputPath, "utf8"));
        } catch (error) {
          throw new CodexGenerationError(
            `Codex CLI returned no parseable structured output. Details: ${errorMessage(error)}`,
            true,
          );
        }
        return schema.parse(parsed);
      } catch (error) {
        if (error instanceof z.ZodError) throw error;

        const retryable =
          error instanceof CodexGenerationError
            ? error.retryable
            : isTransientErrorMessage(errorMessage(error));
        if (!retryable || attempt === MAX_RETRIES) throw error;
      }

      await sleep(1_000 * 2 ** attempt);
    }
  } finally {
    await Promise.allSettled([unlink(schemaPath), unlink(outputPath)]);
  }

  throw new Error("Generation retry loop ended unexpectedly.");
}
