/**
 * gemini.google.com unofficial session client. Runs in the content script so
 * Google cookies are same-origin. Every request sets Gemini's temporary-chat
 * flag, so side chats never appear in Recent chats.
 */
import {
  cleanGeminiText,
  createGeminiStreamState,
  feedGeminiStream,
  finishGeminiStream,
} from "../core/gemini-parse";
import { createLogger } from "../core/log";
import { buildFollowUpPrompt } from "../core/prompt";
import type { AskFollowUpRequest, AskFollowUpResponse } from "../core/types";

const log = createLogger("gemini-session");
const STREAM_PATH =
  "/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate";
const IDLE_TIMEOUT_MS = 30_000;
const FIRST_TEXT_TIMEOUT_MS = 20_000;
const TEXT_SETTLE_TIMEOUT_MS = 12_000;
const TOTAL_STREAM_TIMEOUT_MS = 75_000;
const TOKEN_CACHE_MS = 5 * 60_000;
/** Current Gemini Web default as of the 2026-08 Web catalog. */
const DEFAULT_WEB_MODEL_HASH = "56fdd199312815e2";
/** Build the browser side-channel Gemini now expects for StreamGenerate. */
function buildGeminiModelHeader(requestUuid: string): string {
  const fields: unknown[] = new Array(17).fill(null);
  fields[0] = 1;
  fields[4] = DEFAULT_WEB_MODEL_HASH;
  fields[7] = 1; // temporary-chat flag
  fields[8] = [4, 5, 6, 8]; // current browser capabilities
  fields[11] = 2; // current legacy mode for the default Flash route
  fields[14] = 1; // native mode category
  fields[15] = 1; // standard thinking (fast sidebar follow-ups)
  fields[16] = requestUuid;
  return JSON.stringify(fields);
}
/** Zero-based index of the temporary-chat flag in the inner request array. */
const TEMPORARY_CHAT_INDEX = 45;
const INNER_LENGTH = 99;
/**
 * Fixed fields the Gemini web app sends with every prompt. Without them the
 * model answers with a canned "I encountered an error" reply (HTTP 200).
 */
const UI_FIELDS: Record<number, unknown> = {
  6: [0],
  7: 1,
  10: 1,
  11: 0,
  17: [[0]],
  18: 0,
  27: 1,
  30: [4, 16],
  41: [2],
  49: 0,
  53: 0,
  61: [],
  68: 1,
  79: 1,
  80: 1,
  91: 0,
  96: 0,
  98: 1,
};
const SESSION_HELP =
  "Gemini session unavailable — reload gemini.google.com (and sign in if needed), then try again.";

interface PageTokens {
  /** SNlM0e — only present when signed in. */
  at: string;
  /** cfb2h build label. */
  bl: string;
  /** FdrFJe session id. */
  sid: string;
  /** Multi-account prefix such as "/u/1", or "". */
  prefix: string;
}

let cachedTokens: { value: PageTokens; at: number } | null = null;

class GeminiHttpError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
  }
}

function pickToken(source: string, key: string): string {
  const match = source.match(
    new RegExp(`"${key}"\\s*:\\s*("(?:[^"\\\\]|\\\\.)*")`)
  );
  if (!match) return "";
  try {
    return JSON.parse(match[1]!);
  } catch {
    return "";
  }
}

function tokensFrom(source: string, prefix: string): PageTokens | null {
  const bl = pickToken(source, "cfb2h");
  if (!bl) return null;
  return {
    at: pickToken(source, "SNlM0e"),
    bl,
    sid: pickToken(source, "FdrFJe"),
    prefix,
  };
}

async function getPageTokens(signal?: AbortSignal): Promise<PageTokens> {
  const prefix = location.pathname.match(/^\/u\/\d+/)?.[0] ?? "";
  if (
    cachedTokens &&
    cachedTokens.value.prefix === prefix &&
    Date.now() - cachedTokens.at < TOKEN_CACHE_MS
  ) {
    return cachedTokens.value;
  }
  for (const script of Array.from(document.scripts)) {
    const text = script.textContent ?? "";
    if (!text.includes("cfb2h")) continue;
    const tokens = tokensFrom(text, prefix);
    if (tokens) {
      cachedTokens = { value: tokens, at: Date.now() };
      return tokens;
    }
  }
  // Page scripts can be replaced after hydration; the app shell still has them.
  const res = await fetch(`${prefix}/app`, {
    credentials: "include",
    signal,
  });
  const tokens = res.ok ? tokensFrom(await res.text(), prefix) : null;
  if (!tokens) throw new Error(SESSION_HELP);
  cachedTokens = { value: tokens, at: Date.now() };
  return tokens;
}

type Continuation = [string, string, string] | [string, string];

async function streamGenerate(
  prompt: string,
  continuation: Continuation | null,
  onPartial?: (text: string) => void
): Promise<{
  reply: string;
  conversationId?: string;
  responseId?: string;
  candidateId?: string;
}> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | null = null;
  const touch = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => controller.abort(), IDLE_TIMEOUT_MS);
  };
  touch();
  try {
    return await streamGenerateWithSignal(
      prompt,
      continuation,
      controller.signal,
      onPartial,
      touch
    );
  } catch (err) {
    if (controller.signal.aborted) {
      throw new Error(
        "Gemini stopped making progress for 45 seconds. Reload Gemini and try again."
      );
    }
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function streamGenerateWithSignal(
  prompt: string,
  continuation: Continuation | null,
  signal: AbortSignal,
  onPartial?: (text: string) => void,
  onActivity?: () => void
): Promise<{
  reply: string;
  conversationId?: string;
  responseId?: string;
  candidateId?: string;
}> {
  const tokens = await getPageTokens(signal);
  onActivity?.();
  const lang = navigator.language || "en-US";

  const requestUuid = crypto.randomUUID().toUpperCase();
  const inner: unknown[] = new Array(INNER_LENGTH).fill(null);
  for (const [index, value] of Object.entries(UI_FIELDS)) {
    inner[Number(index)] = value;
  }
  inner[0] = [prompt, 0, null, null, null, null, 0];
  inner[1] = [lang];
  if (continuation) inner[2] = continuation;
  inner[TEMPORARY_CHAT_INDEX] = true;
  inner[59] = requestUuid;

  const body = new URLSearchParams({
    "f.req": JSON.stringify([null, JSON.stringify(inner)]),
  });
  if (tokens.at) body.set("at", tokens.at);

  const query = new URLSearchParams({
    bl: tokens.bl,
    "f.sid": tokens.sid,
    hl: document.documentElement.lang || lang,
    _reqid: String(100000 + Math.floor(Math.random() * 900000)),
    rt: "c",
    pageId: "none",
    "source-path": `${tokens.prefix}/app` || "/app",
  });

  const res = await fetch(`${tokens.prefix}${STREAM_PATH}?${query}`, {
    method: "POST",
    credentials: "include",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded;charset=utf-8",
      "X-Same-Domain": "1",
      "Accept-Language": lang,
      // Modern Gemini Web routes the request/model through this side-channel.
      // Omitting it can leave StreamGenerate queued/stalled even while the
      // normal Gemini UI works fine in the same browser session.
      "x-goog-ext-525001261-jspb": buildGeminiModelHeader(requestUuid),
      "x-goog-ext-525005358-jspb": JSON.stringify([requestUuid, 1]),
      "x-goog-ext-73010989-jspb": "[0]",
      "x-goog-ext-73010990-jspb": "[0,0,0]",
    },
    body,
    signal,
  });
  onActivity?.();
  if (!res.ok) {
    log.error(`StreamGenerate → HTTP ${res.status}`);
    if (res.status === 401 || res.status === 403) {
      throw new GeminiHttpError(SESSION_HELP, res.status);
    }
    if (res.status === 429) {
      throw new GeminiHttpError(
        "Gemini usage limit reached for now — try again later.",
        res.status
      );
    }
    throw new GeminiHttpError(
      `Gemini request failed (HTTP ${res.status}).`,
      res.status
    );
  }

  const state = createGeminiStreamState();
  if (res.body) {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    const startedAt = Date.now();
    let lastTextProgressAt = 0;

    const readWithTimeout = async (timeoutMs: number) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      try {
        return await Promise.race([
          reader.read().then((value) => ({ kind: "read" as const, value })),
          new Promise<{ kind: "timeout" }>((resolve) => {
            timer = setTimeout(() => resolve({ kind: "timeout" }), timeoutMs);
          }),
        ]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    };

    while (true) {
      const now = Date.now();
      const totalLeft = TOTAL_STREAM_TIMEOUT_MS - (now - startedAt);
      const hasText = state.text.trim().length > 0;
      const progressLeft = hasText
        ? TEXT_SETTLE_TIMEOUT_MS - (now - lastTextProgressAt)
        : FIRST_TEXT_TIMEOUT_MS - (now - startedAt);
      const waitMs = Math.max(1, Math.min(totalLeft, progressLeft));

      if (totalLeft <= 0 || progressLeft <= 0) {
        if (hasText) {
          log.debug("Gemini stream settled; using the latest complete text frame");
          await reader.cancel().catch(() => undefined);
          break;
        }
        throw new Error("Gemini did not start answering in time. Reload Gemini and try again.");
      }

      const next = await readWithTimeout(waitMs);
      if (next.kind === "timeout") {
        if (state.text.trim()) {
          log.debug("Gemini stopped changing text; using the latest reply instead of waiting indefinitely");
          await reader.cancel().catch(() => undefined);
          break;
        }
        throw new Error("Gemini did not start answering in time. Reload Gemini and try again.");
      }

      const { done, value } = next.value;
      if (done) break;
      onActivity?.();
      if (feedGeminiStream(state, decoder.decode(value, { stream: true }))) {
        lastTextProgressAt = Date.now();
        onPartial?.(cleanGeminiText(state.text));
      }
    }
    feedGeminiStream(state, decoder.decode());
  } else {
    feedGeminiStream(state, await res.text());
  }
  finishGeminiStream(state);

  const reply = cleanGeminiText(state.text);
  // Gemini can append BardErrorInfo/metadata frames after a perfectly usable
  // text frame. A real reply wins; only surface the protocol error when no
  // readable answer was produced.
  if (!reply && state.error) throw new Error(state.error);
  if (!reply) {
    throw new Error(
      "Gemini returned no readable reply. Its web request or response format may have changed; report this error with extension version 0.2.5."
    );
  }
  log.debug(`Reply received (${reply.length} chars)`);
  return {
    reply,
    conversationId: state.conversationId,
    responseId: state.responseId,
    candidateId: state.candidateId,
  };
}

function shouldRetryFresh(err: unknown): boolean {
  if (err instanceof GeminiHttpError) {
    return [408, 500, 502, 503, 504].includes(err.status);
  }
  const message = err instanceof Error ? err.message : String(err);
  return /failed to fetch|networkerror|temporary error|no readable reply/i.test(
    message
  );
}

async function startFresh(
  prompt: string,
  onPartial?: (text: string) => void
): Promise<Awaited<ReturnType<typeof streamGenerate>>> {
  try {
    return await streamGenerate(prompt, null, onPartial);
  } catch (err) {
    if (!shouldRetryFresh(err)) throw err;
    // Build/session labels can go stale after Gemini hot-reloads. Refresh the
    // page token snapshot and make one clean retry for transient failures.
    cachedTokens = null;
    log.debug("Transient Gemini failure; retrying once with fresh page tokens");
    return streamGenerate(prompt, null, onPartial);
  }
}

export async function completeViaGeminiSession(
  req: AskFollowUpRequest,
  onPartial?: (text: string) => void
): Promise<AskFollowUpResponse> {
  try {
    const promptArgs = {
      quotedText: req.quotedText,
      surroundingContext: req.surroundingContext,
      conversationExcerpt: req.conversationExcerpt,
      question: req.question,
      siteName: "Gemini",
    };

    const toResponse = (r: Awaited<ReturnType<typeof streamGenerate>>) => ({
      ok: true,
      reply: r.reply,
      sideConversationId: r.conversationId,
      sideParentMessageId: r.responseId,
      sideMeta: r.candidateId ? { candidateId: r.candidateId } : undefined,
    });

    // Gemini Web's legacy 2/3-id continuation payload is no longer reliable.
    // One clean temporary request with this thread's prior turns is faster and
    // avoids the old pattern of waiting for a doomed continuation request
    // before retrying from scratch.
    return toResponse(
      await startFresh(
        buildFollowUpPrompt({ ...promptArgs, priorTurns: req.priorTurns }),
        onPartial
      )
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error("complete failed:", message);
    return { ok: false, error: message };
  }
}
