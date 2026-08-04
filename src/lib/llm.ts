import "server-only";

import {
  query,
  type SDKAssistantMessageError,
  type SDKResultMessage,
} from "@anthropic-ai/claude-agent-sdk";
import Anthropic, { type ParsedMessage } from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

const MAX_RETRIES = 2;
const DEFAULT_CODEX_TIMEOUT_MS = 300_000;

let anthropicClient: Anthropic | null = null;

function getClient(): Anthropic {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error(
      "ANTHROPIC_API_KEY is not set. Add it to .env.local and try again.",
    );
  }
  anthropicClient ??= new Anthropic({ apiKey });
  return anthropicClient;
}

function sleep(milliseconds: number) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function refusalErrorMessage(
  details: ParsedMessage<unknown>["stop_details"],
): string {
  const category = details?.category
    ? ` Category: ${details.category}.`
    : "";
  const explanation = details?.explanation
    ? ` ${details.explanation}`
    : "";
  return `Content declined by safety classifier.${category}${explanation}`;
}

async function withApiGenerationRetry<T>(
  request: () => Promise<ParsedMessage<T>>,
): Promise<T> {
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    try {
      const response = await request();
      if (response.stop_reason === "refusal") {
        throw new Error(refusalErrorMessage(response.stop_details));
      }
      if (response.parsed_output !== null) return response.parsed_output;
      if (attempt === MAX_RETRIES) {
        throw new Error("Claude returned no parsed structured output.");
      }
    } catch (error) {
      const retryable =
        error instanceof Anthropic.RateLimitError ||
        error instanceof Anthropic.InternalServerError;
      if (!retryable || attempt === MAX_RETRIES) throw error;
    }
    await sleep(1_000 * 2 ** attempt);
  }
  throw new Error("Generation retry loop ended unexpectedly.");
}

class SubscriptionGenerationError extends Error {
  readonly retryable: boolean;

  constructor(message: string, retryable: boolean) {
    super(message);
    this.name = "SubscriptionGenerationError";
    this.retryable = retryable;
  }
}

class CodexGenerationError extends Error {
  readonly retryable: boolean;

  constructor(message: string, retryable: boolean) {
    super(message);
    this.name = "CodexGenerationError";
    this.retryable = retryable;
  }
}

class SubscriptionAuthenticationError extends Error {
  constructor(details?: string) {
    const suffix = details ? ` Details: ${details}` : "";
    super(
      "Claude subscription authentication failed. Run `claude setup-token` and set CLAUDE_CODE_OAUTH_TOKEN, or sign in with Claude Code on this machine." +
        suffix,
    );
    this.name = "SubscriptionAuthenticationError";
  }
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
  model,
  payload,
  schemaPath,
  outputPath,
  timeoutMilliseconds,
}: {
  model: string;
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
      model,
      "-c",
      "model_reasoning_effort=high",
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

function subscriptionResultError(
  subtype: string,
  errors: string[],
  terminalReason?: string,
  assistantErrors: SDKAssistantMessageError[] = [],
): Error {
  const details = [
    errors.length > 0 ? errors.join("; ") : null,
    terminalReason ? `terminal reason: ${terminalReason}` : null,
    assistantErrors.length > 0
      ? `assistant error: ${assistantErrors.join(", ")}`
      : null,
  ]
    .filter((detail): detail is string => detail !== null)
    .join("; ");
  const message = `Claude Agent SDK generation failed (${subtype})${
    details ? `: ${details}` : "."
  }`;

  if (
    assistantErrors.includes("authentication_failed") ||
    assistantErrors.includes("oauth_org_not_allowed") ||
    isAuthenticationErrorMessage(message)
  ) {
    return new SubscriptionAuthenticationError(message);
  }

  const retryableAssistantError = assistantErrors.some((error) =>
    ["rate_limit", "overloaded", "server_error"].includes(error),
  );
  const nonRetryableAssistantError = assistantErrors.some((error) =>
    [
      "billing_error",
      "invalid_request",
      "model_not_found",
      "max_output_tokens",
    ].includes(error),
  );
  const retryable =
    !nonRetryableAssistantError &&
    (retryableAssistantError ||
      isTransientErrorMessage(message) ||
      (subtype === "error_during_execution" && assistantErrors.length === 0));

  return new SubscriptionGenerationError(message, retryable);
}

async function generateWithSubscription<S extends z.ZodType>({
  model,
  system,
  prompt,
  schema,
}: {
  model: string;
  system: string;
  prompt: string;
  schema: S;
}): Promise<z.infer<S>> {
  const subscriptionEnv: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key !== "ANTHROPIC_API_KEY" && value !== undefined) {
      subscriptionEnv[key] = value;
    }
  }

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    try {
      let resultMessage: SDKResultMessage | undefined;
      const assistantErrors: SDKAssistantMessageError[] = [];
      const authenticationErrors: string[] = [];

      for await (const message of query({
        prompt,
        options: {
          env: subscriptionEnv,
          model,
          systemPrompt: system,
          allowedTools: [],
          tools: [],
          maxTurns: 8,
          settingSources: [],
          thinking: { type: "adaptive" },
          outputFormat: {
            type: "json_schema",
            schema: z.toJSONSchema(schema, { target: "draft-7" }),
          },
        },
      })) {
        if (message.type === "assistant" && message.error) {
          assistantErrors.push(message.error);
        } else if (message.type === "auth_status" && message.error) {
          authenticationErrors.push(message.error);
        } else if (message.type === "result") {
          resultMessage = message;
        }
      }

      if (authenticationErrors.length > 0) {
        throw new SubscriptionAuthenticationError(
          authenticationErrors.join("; "),
        );
      }
      if (!resultMessage) {
        throw new SubscriptionGenerationError(
          "Claude Agent SDK returned no result message.",
          true,
        );
      }
      if (resultMessage.subtype !== "success") {
        throw subscriptionResultError(
          resultMessage.subtype,
          resultMessage.errors,
          resultMessage.terminal_reason,
          assistantErrors,
        );
      }
      if (resultMessage.structured_output === undefined) {
        throw new SubscriptionGenerationError(
          "Claude Agent SDK returned no structured output.",
          true,
        );
      }

      return schema.parse(resultMessage.structured_output);
    } catch (error) {
      if (error instanceof z.ZodError) throw error;
      if (error instanceof SubscriptionAuthenticationError) throw error;

      const message = errorMessage(error);
      if (isAuthenticationErrorMessage(message)) {
        throw new SubscriptionAuthenticationError(message);
      }

      const retryable =
        error instanceof SubscriptionGenerationError
          ? error.retryable
          : isTransientErrorMessage(message);
      if (!retryable || attempt === MAX_RETRIES) throw error;
    }

    await sleep(1_000 * 2 ** attempt);
  }

  throw new Error("Generation retry loop ended unexpectedly.");
}

async function generateWithCodex<S extends z.ZodType>({
  model,
  system,
  prompt,
  schema,
}: {
  model: string;
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
          model,
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

async function generateWithApi<S extends z.ZodType>({
  model,
  system,
  prompt,
  schema,
  maxTokens,
}: {
  model: string;
  system: string;
  prompt: string;
  schema: S;
  maxTokens: number;
}): Promise<z.infer<S>> {
  return withApiGenerationRetry(() =>
    getClient().messages.parse({
      model,
      max_tokens: maxTokens,
      thinking: { type: "adaptive" },
      system,
      messages: [{ role: "user", content: prompt }],
      output_config: { format: zodOutputFormat(schema) },
    }),
  );
}

export async function generateStructured<S extends z.ZodType>(args: {
  model: string;
  system: string;
  prompt: string;
  schema: S;
  maxTokens: number;
  backend?: "api" | "subscription" | "codex";
}): Promise<z.infer<S>> {
  const backend = args.backend ?? process.env.GENERATION_BACKEND;
  if (backend === "subscription") {
    return generateWithSubscription(args);
  }
  if (backend === "codex") {
    return generateWithCodex(args);
  }
  return generateWithApi(args);
}
