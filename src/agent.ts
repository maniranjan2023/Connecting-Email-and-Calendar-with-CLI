import { Composio } from "@composio/core";
import type {
  EndpointDefinition,
  EndpointReport,
  EndpointStatus,
  TestReport,
} from "./types";

// --- Assignment: Gmail + Calendar PASS/FAIL suite --------------------------------

export type AssignmentTestResult = {
  name: string;
  success: boolean;
  details: string;
};

const TEST_EMAIL_SUBJECT = "API Test Email";
const TEST_EMAIL_BODY = "This is a test";
const TEST_EVENT_TITLE = "API Test Event";

function requireApiKey(): void {
  if (!process.env.COMPOSIO_API_KEY?.trim()) {
    throw new Error("Set COMPOSIO_API_KEY (e.g. in .env or your shell).");
  }
}

export function createComposioClient(): Composio {
  requireApiKey();
  return new Composio();
}

export function getConnectedAccountId(): string {
  return process.env.COMPOSIO_CONNECTED_ACCOUNT_ID?.trim() || "candidate";
}

type HttpMethod = "GET" | "POST" | "PUT" | "DELETE" | "PATCH";

async function toolProxy(
  composio: Composio,
  connectedAccountId: string,
  args: {
    endpoint: string;
    method: HttpMethod;
    parameters?: Array<{ in: "query" | "header"; name: string; value: string | number }>;
    body?: unknown;
  }
) {
  return composio.tools.proxyExecute({
    endpoint: args.endpoint,
    method: args.method,
    connectedAccountId,
    parameters: args.parameters,
    body: args.body,
  });
}

function gmailRfc2822Raw(to: string, subject: string, bodyText: string): string {
  const rfc2822 = [
    `To: ${to}`,
    `Subject: ${subject}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=UTF-8",
    "",
    bodyText,
  ].join("\r\n");
  return Buffer.from(rfc2822, "utf8").toString("base64url");
}

async function resolveSelfEmail(
  composio: Composio,
  connectedAccountId: string
): Promise<string> {
  const fromEnv = process.env.GMAIL_SELF_EMAIL?.trim();
  if (fromEnv) return fromEnv;

  const res = await toolProxy(composio, connectedAccountId, {
    endpoint: "/gmail/v1/users/me/profile",
    method: "GET",
  });
  if (res.status < 200 || res.status >= 300) {
    throw new Error(
      `Could not load Gmail profile (${res.status}). Set GMAIL_SELF_EMAIL or fix auth.`
    );
  }
  const data = res.data as { emailAddress?: string };
  if (!data?.emailAddress) {
    throw new Error("Gmail profile had no emailAddress. Set GMAIL_SELF_EMAIL.");
  }
  return data.emailAddress;
}

export async function testGmailSendEmail(
  composio: Composio,
  connectedAccountId: string
): Promise<AssignmentTestResult> {
  const name = "Send Email";
  try {
    const to = await resolveSelfEmail(composio, connectedAccountId);
    const raw = gmailRfc2822Raw(to, TEST_EMAIL_SUBJECT, TEST_EMAIL_BODY);

    const send = await toolProxy(composio, connectedAccountId, {
      endpoint: "/gmail/v1/users/me/messages/send",
      method: "POST",
      body: { raw },
    });

    if (send.status < 200 || send.status >= 300) {
      return {
        name,
        success: false,
        details: `Send failed HTTP ${send.status}: ${truncateJson(send.data)}`,
      };
    }

    const list = await toolProxy(composio, connectedAccountId, {
      endpoint: "/gmail/v1/users/me/messages",
      method: "GET",
      parameters: [
        { in: "query", name: "maxResults", value: 20 },
        { in: "query", name: "q", value: `subject:"${TEST_EMAIL_SUBJECT}"` },
      ],
    });

    if (list.status < 200 || list.status >= 300) {
      return {
        name,
        success: false,
        details: `List after send failed HTTP ${list.status}: ${truncateJson(list.data)}`,
      };
    }

    const msgs = (list.data as { messages?: { id: string; threadId?: string }[] })
      ?.messages;
    const hasAny = (msgs?.length ?? 0) > 0;

    if (!hasAny) {
      return {
        name,
        success: false,
        details:
          "Send returned OK but no messages matched the subject search yet (try increasing delay or check spam).",
      };
    }

    return {
      name,
      success: true,
      details: `Sent to ${to}; found ${msgs!.length} matching message(s) in search.`,
    };
  } catch (e) {
    return {
      name,
      success: false,
      details: e instanceof Error ? e.message : String(e),
    };
  }
}

export async function testGmailReadEmails(
  composio: Composio,
  connectedAccountId: string
): Promise<AssignmentTestResult> {
  const name = "Read Emails";
  try {
    const res = await toolProxy(composio, connectedAccountId, {
      endpoint: "/gmail/v1/users/me/messages",
      method: "GET",
      parameters: [{ in: "query", name: "maxResults", value: 5 }],
    });
    if (res.status < 200 || res.status >= 300) {
      return {
        name,
        success: false,
        details: `HTTP ${res.status}: ${truncateJson(res.data)}`,
      };
    }
    const n = (res.data as { messages?: unknown[] })?.messages?.length ?? 0;
    return {
      name,
      success: n > 0,
      details: n > 0 ? `Fetched ${n} message id(s).` : "messages array empty or missing.",
    };
  } catch (e) {
    return {
      name,
      success: false,
      details: e instanceof Error ? e.message : String(e),
    };
  }
}

export async function testCalendarCreateEvent(
  composio: Composio,
  connectedAccountId: string
): Promise<AssignmentTestResult> {
  const name = "Create Event";
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    const start = new Date(Date.now() + 5 * 60 * 1000);
    const end = new Date(Date.now() + 30 * 60 * 1000);

    const body = {
      summary: TEST_EVENT_TITLE,
      start: { dateTime: start.toISOString(), timeZone: tz },
      end: { dateTime: end.toISOString(), timeZone: tz },
    };

    const create = await toolProxy(composio, connectedAccountId, {
      endpoint: "/calendar/v3/calendars/primary/events",
      method: "POST",
      body,
    });

    if (create.status < 200 || create.status >= 300) {
      return {
        name,
        success: false,
        details: `Create failed HTTP ${create.status}: ${truncateJson(create.data)}`,
      };
    }

    const created = create.data as { id?: string; summary?: string };
    const eventId = created?.id;
    if (!eventId) {
      return { name, success: false, details: "Create OK but no event id in response." };
    }

    const path = `/calendar/v3/calendars/primary/events/${encodeURIComponent(eventId)}`;
    const get = await toolProxy(composio, connectedAccountId, {
      endpoint: path,
      method: "GET",
    });

    if (get.status < 200 || get.status >= 300) {
      return {
        name,
        success: false,
        details: `Created id=${eventId} but GET failed HTTP ${get.status}: ${truncateJson(get.data)}`,
      };
    }

    return {
      name,
      success: true,
      details: `eventId=${eventId}; verified via GET.`,
    };
  } catch (e) {
    return {
      name,
      success: false,
      details: e instanceof Error ? e.message : String(e),
    };
  }
}

export async function testCalendarListEvents(
  composio: Composio,
  connectedAccountId: string
): Promise<AssignmentTestResult> {
  const name = "List Events";
  try {
    const timeMin = new Date().toISOString();
    const res = await toolProxy(composio, connectedAccountId, {
      endpoint: "/calendar/v3/calendars/primary/events",
      method: "GET",
      parameters: [
        { in: "query", name: "maxResults", value: 25 },
        { in: "query", name: "timeMin", value: timeMin },
        { in: "query", name: "singleEvents", value: "true" },
      ],
    });
    if (res.status < 200 || res.status >= 300) {
      return {
        name,
        success: false,
        details: `HTTP ${res.status}: ${truncateJson(res.data)}`,
      };
    }
    const items = (res.data as { items?: unknown[] })?.items ?? [];
    return {
      name,
      success: items.length > 0,
      details:
        items.length > 0
          ? `Upcoming events: ${items.length}`
          : "items empty (no upcoming events in window).",
    };
  } catch (e) {
    return {
      name,
      success: false,
      details: e instanceof Error ? e.message : String(e),
    };
  }
}

function printAssignmentResults(results: AssignmentTestResult[]): void {
  console.log("\nTEST RESULTS:\n");
  for (const r of results) {
    console.log(`${r.success ? "✅" : "❌"} ${r.name} → ${r.success ? "PASS" : "FAIL"}`);
    if (!r.success && r.details) console.log(`   ${r.details}`);
  }
  console.log("");
}

/**
 * Runs the assignment test suite (Gmail + Calendar) and prints PASS/FAIL.
 */
export async function runAssignmentSuite(): Promise<AssignmentTestResult[]> {
  const composio = createComposioClient();
  const id = getConnectedAccountId();

  const results: AssignmentTestResult[] = [];
  results.push(await testGmailSendEmail(composio, id));
  results.push(await testGmailReadEmails(composio, id));
  results.push(await testCalendarCreateEvent(composio, id));
  results.push(await testCalendarListEvents(composio, id));

  printAssignmentResults(results);
  return results;
}

// --- Interview runner: generic endpoint report ----------------------------------

type ExecCtx = {
  userEmail?: string;
  listMessageId?: string;
  sentMessageId?: string;
  eventIdFromList?: string;
  createdEventId?: string;
};

function classifyStatus(httpStatus: number): { status: EndpointStatus; summary: string } {
  if (httpStatus >= 200 && httpStatus < 300) {
    return { status: "valid", summary: `HTTP ${httpStatus} success.` };
  }
  if (httpStatus === 403) {
    return {
      status: "insufficient_scopes",
      summary: "HTTP 403 — likely missing OAuth scopes for this resource.",
    };
  }
  if (httpStatus === 404 || httpStatus === 405) {
    return {
      status: "invalid_endpoint",
      summary: `HTTP ${httpStatus} — route may not exist or method not allowed.`,
    };
  }
  if (httpStatus === 0) {
    return { status: "error", summary: "Request failed before HTTP response (network/SDK error)." };
  }
  return {
    status: "error",
    summary: `HTTP ${httpStatus} — request reached the API but was not successful.`,
  };
}

function truncateJson(data: unknown, max = 4000): unknown {
  try {
    const s = JSON.stringify(data);
    if (s.length <= max) return data;
    return s.slice(0, max) + "…(truncated)";
  } catch {
    return String(data).slice(0, max);
  }
}

function redactBody(data: unknown): unknown {
  const sensitiveKeys = /password|token|authorization|secret|raw|refresh/i;
  if (data === null || typeof data !== "object") return data;
  if (Array.isArray(data)) return data.map(redactBody);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    if (sensitiveKeys.test(k)) out[k] = "[redacted]";
    else out[k] = redactBody(v);
  }
  return out;
}

function substitutePath(path: string, vars: Record<string, string | undefined>): string {
  return path.replace(/\{(\w+)\}/g, (_, key: string) => {
    const v = vars[key];
    return v !== undefined && v !== "" ? encodeURIComponent(v) : `{${key}}`;
  });
}

async function executeSlug(
  ep: EndpointDefinition,
  ctx: ExecCtx,
  composio: Composio,
  connectedAccountId: string
): Promise<{ http: number; body: unknown }> {
  const method = ep.method.toUpperCase() as HttpMethod;
  const vars: Record<string, string | undefined> = {
    messageId: ctx.sentMessageId ?? ctx.listMessageId,
    eventId: ctx.createdEventId ?? ctx.eventIdFromList,
  };

  let endpoint = substitutePath(ep.path, vars);
  let parameters:
    | Array<{ in: "query" | "header"; name: string; value: string | number }>
    | undefined;
  let body: unknown;

  switch (ep.tool_slug) {
    case "GMAIL_SEND_MESSAGE": {
      const to = ctx.userEmail ?? (await resolveSelfEmail(composio, connectedAccountId));
      ctx.userEmail = ctx.userEmail ?? to;
      body = { raw: gmailRfc2822Raw(to, "Endpoint tester", "ping") };
      break;
    }
    case "GMAIL_CREATE_DRAFT": {
      const to = ctx.userEmail ?? (await resolveSelfEmail(composio, connectedAccountId));
      ctx.userEmail = ctx.userEmail ?? to;
      body = {
        message: { raw: gmailRfc2822Raw(to, "Draft ping", "draft body") },
      };
      break;
    }
    case "GOOGLECALENDAR_CREATE_EVENT": {
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
      const start = new Date(Date.now() + 6 * 60 * 1000);
      const end = new Date(Date.now() + 36 * 60 * 1000);
      body = {
        summary: "Endpoint tester event",
        start: { dateTime: start.toISOString(), timeZone: tz },
        end: { dateTime: end.toISOString(), timeZone: tz },
      };
      break;
    }
    case "GMAIL_LIST_MESSAGES":
    case "GMAIL_LIST_THREADS":
      parameters = [{ in: "query", name: "maxResults", value: 10 }];
      break;
    case "GOOGLECALENDAR_LIST_EVENTS":
      parameters = [
        { in: "query", name: "maxResults", value: 10 },
        { in: "query", name: "timeMin", value: new Date().toISOString() },
        { in: "query", name: "singleEvents", value: "true" },
      ];
      break;
    case "GOOGLECALENDAR_LIST_CALENDARS":
      parameters = [{ in: "query", name: "maxResults", value: 10 }];
      break;
    default:
      break;
  }

  if (endpoint.includes("{")) {
    return {
      http: 0,
      body: `Unresolved path placeholders: ${endpoint}`,
    };
  }

  try {
    const res = await toolProxy(composio, connectedAccountId, {
      endpoint,
      method,
      parameters,
      body,
    });

    if (ep.tool_slug === "GMAIL_GET_PROFILE" && res.status >= 200 && res.status < 300) {
      ctx.userEmail = (res.data as { emailAddress?: string }).emailAddress ?? ctx.userEmail;
    }
    if (ep.tool_slug === "GMAIL_LIST_MESSAGES" && res.status >= 200 && res.status < 300) {
      const mid = (res.data as { messages?: { id: string }[] })?.messages?.[0]?.id;
      if (mid) ctx.listMessageId = mid;
    }
    if (ep.tool_slug === "GMAIL_SEND_MESSAGE" && res.status >= 200 && res.status < 300) {
      ctx.sentMessageId = (res.data as { id?: string })?.id ?? ctx.sentMessageId;
    }
    if (ep.tool_slug === "GOOGLECALENDAR_LIST_EVENTS" && res.status >= 200 && res.status < 300) {
      ctx.eventIdFromList = (res.data as { items?: { id: string }[] })?.items?.[0]?.id;
    }
    if (ep.tool_slug === "GOOGLECALENDAR_CREATE_EVENT" && res.status >= 200 && res.status < 300) {
      ctx.createdEventId = (res.data as { id?: string })?.id ?? ctx.createdEventId;
    }

    return { http: res.status, body: res.data };
  } catch (e) {
    return { http: 0, body: e instanceof Error ? e.message : String(e) };
  }
}

const RUN_ORDER: string[] = [
  "GMAIL_GET_PROFILE",
  "GMAIL_LIST_MESSAGES",
  "GMAIL_GET_MESSAGE",
  "GMAIL_LIST_LABELS",
  "GMAIL_LIST_THREADS",
  "GMAIL_LIST_FOLDERS",
  "GOOGLECALENDAR_LIST_CALENDARS",
  "GOOGLECALENDAR_LIST_EVENTS",
  "GOOGLECALENDAR_LIST_REMINDERS",
  "GMAIL_SEND_MESSAGE",
  "GMAIL_CREATE_DRAFT",
  "GOOGLECALENDAR_CREATE_EVENT",
  "GOOGLECALENDAR_GET_EVENT",
  "GMAIL_TRASH_MESSAGE",
  "GMAIL_ARCHIVE_MESSAGE",
  "GOOGLECALENDAR_DELETE_EVENT",
];

/**
 * Interview harness — tests every endpoint definition via `proxyExecute` and returns a full TestReport.
 */
export async function runAgent(params: {
  composio: Composio;
  connectedAccountId: string;
  endpoints: EndpointDefinition[];
}): Promise<TestReport> {
  const bySlug = new Map(params.endpoints.map((e) => [e.tool_slug, e]));
  const ctx: ExecCtx = {};
  const results: EndpointReport[] = [];
  const ts = new Date().toISOString();

  const slugsToRun = [
    ...RUN_ORDER.filter((s) => bySlug.has(s)),
    ...params.endpoints.map((e) => e.tool_slug).filter((s) => !RUN_ORDER.includes(s)),
  ];

  for (const slug of slugsToRun) {
    const ep = bySlug.get(slug);
    if (!ep) continue;
    const { http, body } = await executeSlug(ep, ctx, params.composio, params.connectedAccountId);
    const { status, summary } = classifyStatus(http);
    results.push({
      tool_slug: ep.tool_slug,
      method: ep.method,
      path: ep.path,
      status,
      http_status_code: http === 0 ? null : http,
      response_summary: summary,
      response_body: redactBody(truncateJson(body)),
      required_scopes: ep.required_scopes,
      available_scopes: [],
    });
  }

  const summaryCounts = {
    valid: 0,
    invalid_endpoint: 0,
    insufficient_scopes: 0,
    error: 0,
  };
  for (const r of results) {
    summaryCounts[r.status]++;
  }

  return {
    timestamp: ts,
    total_endpoints: params.endpoints.length,
    results,
    summary: summaryCounts,
  };
}
