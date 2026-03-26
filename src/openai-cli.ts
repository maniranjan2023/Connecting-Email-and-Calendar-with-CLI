/**
 * Natural-language Gmail + Calendar assistant using OpenAI tool calling
 * and the same Composio proxy stack as `agent.ts`.
 *
 * Run: bun run ai
 */
import OpenAI from "openai";
import * as readline from "node:readline/promises";
import type { Composio } from "@composio/core";
import {
  assertAssignmentAccounts,
  composioProxyExecute,
  createComposioClient,
  encodeGmailMessageRaw,
  getConnectedAccountId,
  loadToolkitAccountMap,
  type ToolkitAccountMap,
} from "./agent";

function requireOpenAiKey(): void {
  if (!process.env.OPENAI_API_KEY?.trim()) {
    throw new Error("Set OPENAI_API_KEY in .env");
  }
}

const MODEL = process.env.OPENAI_MODEL?.trim() || "gpt-4o-mini";

const tools: OpenAI.Chat.Completions.ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "gmail_get_profile",
      description: "Get the connected Gmail account email address and basic profile.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "gmail_list_messages",
      description:
        "List Gmail messages (newest first). When the user says **inbox**, set inbox_only=true so only INBOX is listed (not Sent/All Mail).",
      parameters: {
        type: "object",
        properties: {
          max_results: {
            type: "integer",
            description: "Max messages to return, 1–50 (default 10).",
          },
          query: {
            type: "string",
            description: "Optional Gmail search query (e.g. in:inbox). inbox_only=true is preferred for inbox.",
          },
          inbox_only: {
            type: "boolean",
            description: "If true, only messages in the INBOX label (use for “emails in my inbox”).",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "gmail_get_message",
      description:
        "Fetch one Gmail message by id. For **summaries**, always use format **full** (default) so body text is available; **metadata** is only for subject/snippet without body.",
      parameters: {
        type: "object",
        properties: {
          message_id: { type: "string", description: "Gmail message id from list_messages." },
          format: {
            type: "string",
            enum: ["minimal", "full", "metadata", "raw"],
            description: "Use **full** when summarizing (default). Use metadata only for a lightweight peek.",
          },
        },
        required: ["message_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "gmail_send_email",
      description: "Send an email from the connected Gmail account.",
      parameters: {
        type: "object",
        properties: {
          to: { type: "string", description: "Recipient email address." },
          subject: { type: "string" },
          body: { type: "string", description: "Plain-text body." },
        },
        required: ["to", "subject", "body"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "calendar_list_events",
      description: "List upcoming events on the primary calendar from now onward.",
      parameters: {
        type: "object",
        properties: {
          max_results: { type: "integer", description: "1–50, default 20." },
          time_min_iso: {
            type: "string",
            description: "RFC3339 lower bound; default is now.",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "calendar_create_event",
      description:
        "Create an event **only** after the user has given enough timing. Do not invent times. If they only said 'schedule a meeting' or 'book X' with **no** date/time (and no clear relative like 'in 1 hour'), do **not** call this — ask them in plain text first.",
      parameters: {
        type: "object",
        properties: {
          summary: { type: "string", description: "Event title." },
          start_iso: {
            type: "string",
            description: "Start as ISO 8601. Only fill after user gave timing (or explicit relative they stated).",
          },
          end_iso: {
            type: "string",
            description: "End as ISO 8601. Same rule as start_iso.",
          },
          description: { type: "string", description: "Optional description." },
          user_confirmed_timing: {
            type: "boolean",
            description:
              "true only if the user message explicitly supplied when to meet: (a) date + time, or (b) clear relative time ('in 30 min', 'tomorrow 9am'). false if timing was missing or vague — then skip this tool and ask the user.",
          },
        },
        required: ["summary", "start_iso", "end_iso", "user_confirmed_timing"],
      },
    },
  },
];

type ToolCtx = {
  composio: Composio;
  map: ToolkitAccountMap;
  fallback: string;
};

function asObj(args: string): Record<string, unknown> {
  try {
    return JSON.parse(args || "{}") as Record<string, unknown>;
  } catch {
    return {};
  }
}

function clip(s: string, max = 28000): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + "\n…(truncated for model context)";
}

/** Keep Google Calendar list events small and valid JSON for the model (avoids huge recurrence fields). */
function simplifyCalendarListData(data: unknown): unknown {
  if (!data || typeof data !== "object") return data;
  const d = data as Record<string, unknown>;
  const items = d.items;
  if (!Array.isArray(items)) return data;
  return {
    ...d,
    items: items.map((ev) => {
      if (!ev || typeof ev !== "object") return ev;
      const e = ev as Record<string, unknown>;
      return {
        id: e.id,
        summary: e.summary,
        status: e.status,
        start: e.start,
        end: e.end,
        htmlLink: e.htmlLink,
      };
    }),
  };
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms)
    ),
  ]);
}

/** Cap body_text inside gmail_get_message tool JSON so many unread mails don't freeze the final LLM call. */
function shrinkGmailToolResult(jsonStr: string, bodyMax: number): string {
  try {
    const o = JSON.parse(jsonStr) as { data?: { body_text?: string; snippet?: string } };
    if (o.data && typeof o.data.body_text === "string" && o.data.body_text.length > bodyMax) {
      o.data.body_text = o.data.body_text.slice(0, bodyMax) + "…";
    }
    return JSON.stringify(o);
  } catch {
    return clip(jsonStr, 4500);
  }
}

/**
 * If JSON is still over hardCap after Gmail shrink, shrink calendar `data.items` or drop items
 * until the string fits — never blind-slice mid-JSON (that breaks parsing and the model may refuse to answer).
 */
function shrinkToolJsonToHardCap(jsonStr: string, hardCap: number): string {
  if (jsonStr.length <= hardCap) return jsonStr;
  try {
    const o = JSON.parse(jsonStr) as {
      http_status?: number;
      data?: { items?: unknown[] };
      error?: unknown;
    };
    const items = o.data?.items;
    if (Array.isArray(items)) {
      for (let n = items.length; n >= 0; n--) {
        const trial = {
          ...o,
          data: { ...o.data, items: items.slice(0, n) },
        };
        const t = JSON.stringify(trial);
        if (t.length <= hardCap) return t;
      }
    }
  } catch {
    /* fall through */
  }
  return jsonStr.slice(0, hardCap) + "…";
}

/** Last-line shrink of all tool payloads before the final tool_choice:none request. */
function compressToolMessagesForFinalLlm(
  messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[],
  bodyMax: number,
  hardCap: number
): void {
  for (const m of messages) {
    if (m.role !== "tool") continue;
    const raw = m.content;
    if (typeof raw !== "string") continue;
    let s = shrinkGmailToolResult(raw, bodyMax);
    if (s.length > hardCap) s = shrinkToolJsonToHardCap(s, hardCap);
    (m as { content: string }).content = s;
  }
}

function decodeGmailBodyB64(data: string): string {
  try {
    const norm = data.replace(/-/g, "+").replace(/_/g, "/");
    return Buffer.from(norm, "base64").toString("utf8");
  } catch {
    return "";
  }
}

function headerMap(
  headers: unknown
): { subject?: string; from?: string; date?: string } {
  const out: { subject?: string; from?: string; date?: string } = {};
  if (!Array.isArray(headers)) return out;
  for (const h of headers as { name?: string; value?: string }[]) {
    const n = h.name?.toLowerCase();
    if (n === "subject") out.subject = h.value;
    if (n === "from") out.from = h.value;
    if (n === "date") out.date = h.value;
  }
  return out;
}

function extractPlainFromPart(part: unknown, depth = 0): string {
  if (depth > 12 || !part || typeof part !== "object") return "";
  const p = part as Record<string, unknown>;
  const mime = String(p.mimeType || "");
  if (typeof p.data === "string") {
    if (mime === "text/plain") return decodeGmailBodyB64(p.data);
    if (mime === "text/html") {
      const raw = decodeGmailBodyB64(p.data);
      return raw
        .replace(/<script[\s\S]*?<\/script>/gi, "")
        .replace(/<style[\s\S]*?<\/style>/gi, "")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim();
    }
  }
  const parts = p.parts;
  if (Array.isArray(parts)) {
    const chunks: string[] = [];
    for (const sub of parts) {
      const t = extractPlainFromPart(sub, depth + 1);
      if (t) chunks.push(t);
    }
    return chunks.join("\n");
  }
  return "";
}

/** Shrink Gmail API "full" message to what the model needs for summaries. */
function simplifyGmailFullResponse(data: unknown): unknown {
  if (!data || typeof data !== "object") return data;
  const d = data as Record<string, unknown>;
  const pl = d.payload as Record<string, unknown> | undefined;
  const headers = pl?.headers;
  const hm = headerMap(headers);
  const bodyText = pl ? extractPlainFromPart(pl) : "";
  return {
    id: d.id,
    threadId: d.threadId,
    internalDate: d.internalDate,
    snippet: d.snippet,
    subject: hm.subject,
    from: hm.from,
    date: hm.date,
    body_text: bodyText.slice(0, 5000) || d.snippet || "",
  };
}

async function runTool(name: string, argsJson: string, ctx: ToolCtx): Promise<string> {
  const a = asObj(argsJson);

  switch (name) {
    case "gmail_get_profile": {
      const res = await composioProxyExecute(ctx.composio, ctx.map, ctx.fallback, {
        endpoint: "/gmail/v1/users/me/profile",
        method: "GET",
      });
      return clip(JSON.stringify({ http_status: res.status, data: res.data }));
    }

    case "gmail_list_messages": {
      const max = Math.min(50, Math.max(1, Number(a.max_results) || 10));
      const parameters: Array<{ in: "query"; name: string; value: string | number }> = [
        { in: "query", name: "maxResults", value: max },
      ];
      const inboxOnly = a.inbox_only === true;
      if (inboxOnly) {
        parameters.push({ in: "query", name: "labelIds", value: "INBOX" });
      }
      const q = typeof a.query === "string" ? a.query.trim() : "";
      if (q) parameters.push({ in: "query", name: "q", value: q });
      const res = await composioProxyExecute(ctx.composio, ctx.map, ctx.fallback, {
        endpoint: "/gmail/v1/users/me/messages",
        method: "GET",
        parameters,
      });
      return clip(JSON.stringify({ http_status: res.status, data: res.data }));
    }

    case "gmail_get_message": {
      const id = String(a.message_id || "").trim();
      if (!id) return JSON.stringify({ error: "message_id required" });
      const fmt = typeof a.format === "string" ? a.format : "full";
      const path = `/gmail/v1/users/me/messages/${encodeURIComponent(id)}`;
      const res = await composioProxyExecute(ctx.composio, ctx.map, ctx.fallback, {
        endpoint: path,
        method: "GET",
        parameters: [{ in: "query", name: "format", value: fmt }],
      });
      const dataOut =
        fmt === "full" && res.status >= 200 && res.status < 300
          ? simplifyGmailFullResponse(res.data)
          : res.data;
      return clip(JSON.stringify({ http_status: res.status, data: dataOut }), 7500);
    }

    case "gmail_send_email": {
      const to = String(a.to || "").trim();
      const subject = String(a.subject ?? "");
      const body = String(a.body ?? "");
      if (!to.includes("@")) return JSON.stringify({ error: "invalid to address" });
      const raw = encodeGmailMessageRaw(to, subject, body);
      const res = await composioProxyExecute(ctx.composio, ctx.map, ctx.fallback, {
        endpoint: "/gmail/v1/users/me/messages/send",
        method: "POST",
        body: { raw },
      });
      return clip(JSON.stringify({ http_status: res.status, data: res.data }));
    }

    case "calendar_list_events": {
      const max = Math.min(50, Math.max(1, Number(a.max_results) || 20));
      const timeMin =
        typeof a.time_min_iso === "string" && a.time_min_iso.trim()
          ? a.time_min_iso.trim()
          : new Date().toISOString();
      const res = await composioProxyExecute(ctx.composio, ctx.map, ctx.fallback, {
        endpoint: "/calendar/v3/calendars/primary/events",
        method: "GET",
        parameters: [
          { in: "query", name: "maxResults", value: max },
          { in: "query", name: "timeMin", value: timeMin },
          { in: "query", name: "singleEvents", value: "true" },
          { in: "query", name: "orderBy", value: "startTime" },
        ],
      });
      const dataOut =
        res.status >= 200 && res.status < 300
          ? simplifyCalendarListData(res.data)
          : res.data;
      if (res.status < 200 || res.status >= 300) {
        console.error(
          `  [calendar_list_events] HTTP ${res.status} — check Calendar connection + COMPOSIO_GOOGLECALENDAR_CONNECTED_ACCOUNT_ID.\n`
        );
      }
      return clip(JSON.stringify({ http_status: res.status, data: dataOut }), 12000);
    }

    case "calendar_create_event": {
      if (a.user_confirmed_timing !== true) {
        return JSON.stringify({
          http_status: 0,
          error:
            "Not scheduled: user_confirmed_timing was false or missing. Ask the user for the date, start time, and end time (or duration). Do not guess times like 2:30pm.",
        });
      }
      const summary = String(a.summary ?? "").trim();
      const startIso = String(a.start_iso ?? "").trim();
      const endIso = String(a.end_iso ?? "").trim();
      const description =
        typeof a.description === "string" ? a.description : undefined;
      if (!summary || !startIso || !endIso) {
        return JSON.stringify({ error: "summary, start_iso, end_iso required" });
      }
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
      const body: Record<string, unknown> = {
        summary,
        start: { dateTime: startIso, timeZone: tz },
        end: { dateTime: endIso, timeZone: tz },
      };
      if (description) body.description = description;
      const res = await composioProxyExecute(ctx.composio, ctx.map, ctx.fallback, {
        endpoint: "/calendar/v3/calendars/primary/events",
        method: "POST",
        body,
      });
      return clip(JSON.stringify({ http_status: res.status, data: res.data }));
    }

    default:
      return JSON.stringify({ error: `unknown tool ${name}` });
  }
}

const SYSTEM = `You help the user with Gmail and Google Calendar using the provided tools.
Always use tools for mailbox and calendar actions (never pretend you called an API).

**Inbox:** If the user asks for mail in their **inbox**, call gmail_list_messages with inbox_only=true (and max_results as requested).

**Fetching for summaries:** List the right messages, then gmail_get_message per message with format **full** (default). Tool results include body_text. For **unread** lists, call **at most 5–8** gmail_get_message tools per turn (not 15+); otherwise the next step may time out.

**Final reply when user wants summaries:** After tools return, number each message (1., 2., …). For EACH message use this exact structure so the user can read everything in the terminal:
  1) **Meta** — one line: From, date, subject (compact).
  2) **Summary** — a short paragraph in your own words (purpose, key facts, deadlines).
  3) **Body** — copy the email’s **body_text** from the tool result verbatim (or the full body_text if it fits). If body_text is empty, write **Body:** (empty — check snippet/HTML only in API).

If they didn’t ask for a summary, you may answer more briefly without this full structure.

**Calendar — listing events (critical):**
- After **calendar_list_events** returns, read **http_status** and **data** in the tool message.
- If http_status is 2xx and **data.items** is empty or missing, say clearly that there are **no upcoming events** in the window (do not say you could not fetch).
- If http_status is 2xx and **data.items** has events, list each with title, start, and end (from the tool JSON). Do **not** say you cannot fetch or cannot access the calendar when the tool succeeded.
- If http_status is not 2xx or the payload shows an API error, explain that error briefly (e.g. reconnect Calendar in Composio) instead of guessing.

**Calendar — creating events (critical):**
- Do **not** call calendar_create_event with invented or default times (e.g. do not pick 2:30pm or 'now' unless the user said so).
- If the user asks to schedule/book but gives **no** date, **no** time, and **no** clear relative phrase ('in 15 minutes', 'tomorrow morning'), **do not** call calendar_create_event. Reply and **ask** what date, what start time, and what end time or duration they want.
- If they give only a time without a date, ask which **date** before creating.
- Only call calendar_create_event with user_confirmed_timing=true when the user (or their clear relative phrase) gave enough to compute start_iso and end_iso without guessing.
- For listing events, calendar_list_events is fine without extra timing from the user.`;

function augmentIfSummaryRequest(userLine: string): string {
  if (
    !/\b(summarize|summarise|summrize|summarizing|summary|summaries|overview|tl;?dr|in short|key points)\b/i.test(
      userLine
    )
  ) {
    return userLine;
  }
  return `${userLine}

(Assistant: After using tools, for each email output **Meta**, **Summary**, and **Body** (Body = verbatim body_text from tools so it shows in the CLI).)`;
}

function batchIsOnlyGmailList(toolCalls: OpenAI.Chat.ChatCompletionMessageToolCall[]): boolean {
  const names = toolCalls.filter((tc) => tc.type === "function").map((tc) => tc.function.name);
  return names.length > 0 && names.every((n) => n === "gmail_list_messages");
}

async function chatTurn(
  openai: OpenAI,
  messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[],
  ctx: ToolCtx
): Promise<void> {
  const maxRounds = 12;
  const apiTimeoutMs = 240_000;
  /** After list-only, allow one more model turn with tools (e.g. fetch bodies). Otherwise force plain text. */
  let allowTools = true;

  for (let round = 0; round < maxRounds; round++) {
    // Final phase: shrink tool payloads (7× full mail often hangs providers) then answer without tools.
    if (!allowTools) {
      compressToolMessagesForFinalLlm(messages, 900, 5500);

      const finalParams = {
        model: MODEL,
        messages,
        tools,
        tool_choice: "none" as const,
        max_completion_tokens: 6144,
      };

      console.log("  … generating answer (compressed tool data, please wait…) …\n");

      try {
        const completion = await withTimeout(
          openai.chat.completions.create(finalParams),
          120_000,
          "OpenAI final (non-stream)"
        );
        const text = completion.choices[0]?.message?.content?.trim();
        if (text) {
          console.log(`\n${text}\n`);
          return;
        }
        console.log("(empty reply — trying stream…) \n");
      } catch (err) {
        console.error(
          `\nOpenAI final non-stream failed: ${
            err instanceof Error ? err.message : String(err)
          }\nTrying stream…\n`
        );
      }

      const ac = new AbortController();
      const kill = setTimeout(() => ac.abort(), 120_000);
      try {
        const stream = (await openai.chat.completions.create(
          { ...finalParams, stream: true },
          { signal: ac.signal }
        )) as AsyncIterable<OpenAI.Chat.Completions.ChatCompletionChunk>;

        for await (const chunk of stream) {
          const piece = chunk.choices[0]?.delta?.content;
          if (piece) process.stdout.write(piece);
        }
        console.log("\n");
      } catch (err) {
        if ((err as Error).name === "AbortError") {
          console.error("\nOpenAI stream aborted after 120s (context may still be too large). Try: summarize fewer emails.\n");
        } else {
          console.error(
            err instanceof Error ? err.message : String(err),
            "\n"
          );
        }
      } finally {
        clearTimeout(kill);
      }
      return;
    }

    if (round > 0) {
      console.log("  … next model step …\n");
    }

    let completion: OpenAI.Chat.Completions.ChatCompletion;
    try {
      completion = await withTimeout(
        openai.chat.completions.create({
          model: MODEL,
          messages,
          tools,
          tool_choice: "auto",
          max_completion_tokens: 8192,
        }),
        apiTimeoutMs,
        "OpenAI chat.completions"
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`\nOpenAI request failed: ${msg}\n`);
      if (err && typeof err === "object" && "error" in err) {
        console.error(JSON.stringify((err as { error?: unknown }).error, null, 2));
      }
      return;
    }

    const choice = completion.choices[0];
    const msg = choice?.message;
    if (!msg) {
      console.log("(no response)");
      return;
    }

    if (!msg.tool_calls?.length) {
      const text = msg.content?.trim() || "(no text)";
      console.log(`\n${text}\n`);
      return;
    }

    messages.push(msg);

    allowTools = batchIsOnlyGmailList(msg.tool_calls);

    let ti = 0;
    const tn = msg.tool_calls.filter((t) => t.type === "function").length;
    for (const tc of msg.tool_calls) {
      if (tc.type !== "function") continue;
      const name = tc.function.name;
      const args = tc.function.arguments ?? "{}";
      console.log(`  → ${name}(${args.length > 120 ? args.slice(0, 120) + "…" : args})`);
      const output = await runTool(name, args, ctx);
      ti += 1;
      let content = clip(output, 6500);
      if (name === "gmail_get_message") {
        content = shrinkGmailToolResult(content, 1400);
      }
      messages.push({
        role: "tool",
        tool_call_id: tc.id,
        content,
      });
      console.log(`  … done ${ti}/${tn}\n`);
    }
  }

  console.log("\n(stopped: max tool rounds — try a narrower request)\n");
}

async function main(): Promise<void> {
  requireOpenAiKey();
  const composio = createComposioClient();
  const map = await loadToolkitAccountMap(composio);
  assertAssignmentAccounts(map);
  const fallback = getConnectedAccountId();

  const openai = new OpenAI({
    apiKey: process.env.OPENAI_API_KEY,
    timeout: 180_000,
    maxRetries: 1,
  });

  const ctx: ToolCtx = { composio, map, fallback };

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  console.log(`
Gmail + Calendar (OpenAI tools) — model: ${MODEL}
Examples:
  Summarize my last 5 emails
  Send an email to alex@example.com with subject Hello and body Meeting at 3
  List my upcoming calendar events
  Schedule a 30-minute meeting titled Demo starting in 2 hours
Type exit or quit to leave.
`);
  try {
    while (true) {
      const line = (await rl.question("You: ")).trim();
      if (!line) continue;
      if (/^(exit|quit)$/i.test(line)) break;

      const userContent = augmentIfSummaryRequest(line);

      const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
        { role: "system", content: SYSTEM },
        { role: "user", content: userContent },
      ];

      await chatTurn(openai, messages, ctx);
    }
  } finally {
    rl.close();
  }
}

main().catch((err) => {
  console.error("Fatal:", err instanceof Error ? err.message : err);
  process.exit(1);
});
