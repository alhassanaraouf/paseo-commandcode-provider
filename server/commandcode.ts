/** Minimal NDJSON surface of `commandcode -p --output-format json`. */

export interface ToolUsage {
  inputTokens?: number;
  outputTokens?: number;
}

export type CommandcodeLine =
  | { kind: "run_start"; sessionId: string }
  | { kind: "thinking_delta"; delta: string }
  | { kind: "thinking_end"; text: string }
  | { kind: "text_delta"; delta: string }
  | { kind: "message_update"; text: string; thinking: string }
  | { kind: "tool_queued"; toolCallId: string; toolName: string; input: Record<string, unknown> }
  | { kind: "tool_running"; toolCallId: string; toolName: string }
  | { kind: "tool_completed"; toolCallId: string; toolName: string; resultText: string }
  | { kind: "turn_end"; usage: ToolUsage }
  | { kind: "run_end"; sessionId: string; finalText: string }
  | { kind: "ignored" };

interface LooseEvent {
  type?: string;
  sessionId?: string;
  delta?: string;
  text?: string;
  content?: Array<{ type?: string; text?: string; thinking?: string }>;
  toolCallId?: string;
  toolName?: string;
  input?: Record<string, unknown>;
  result?: Array<{ type?: string; text?: string }>;
  usage?: { inputTokens?: number; outputTokens?: number };
  resultSummary?: { finalText?: string; sessionId?: string };
  finalText?: string;
}

function textOf(content: LooseEvent["content"], key: "text" | "thinking"): string {
  return (content ?? [])
    .filter((part) => typeof part?.[key] === "string")
    .map((part) => part[key] as string)
    .join("");
}

function resultTextOf(result: LooseEvent["result"]): string {
  return (result ?? [])
    .filter((part) => part?.type === "text" && typeof part.text === "string")
    .map((part) => part.text as string)
    .join("\n");
}

export function parseLine(line: string): CommandcodeLine {
  let outer: Record<string, unknown>;
  try {
    outer = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return { kind: "ignored" };
  }
  if (outer.type === "result") {
    const sessionId = typeof outer.sessionId === "string" ? outer.sessionId : "";
    const finalText = typeof outer.finalText === "string" ? outer.finalText : "";
    return { kind: "run_end", sessionId, finalText };
  }
  if (outer.type !== "event" || typeof outer.event !== "object" || outer.event === null) {
    return { kind: "ignored" };
  }
  const event = outer.event as LooseEvent;
  switch (event.type) {
    case "run_start":
      return typeof event.sessionId === "string"
        ? { kind: "run_start", sessionId: event.sessionId }
        : { kind: "ignored" };
    case "thinking_delta":
      return typeof event.delta === "string"
        ? { kind: "thinking_delta", delta: event.delta }
        : { kind: "ignored" };
    case "thinking_end":
      return typeof event.text === "string"
        ? { kind: "thinking_end", text: event.text }
        : { kind: "ignored" };
    case "text_delta":
      return typeof event.delta === "string"
        ? { kind: "text_delta", delta: event.delta }
        : { kind: "ignored" };
    case "message_update":
      return {
        kind: "message_update",
        text: textOf(event.content, "text"),
        thinking: textOf(event.content, "thinking"),
      };
    case "tool_queued":
      return event.toolCallId && event.toolName
        ? { kind: "tool_queued", toolCallId: event.toolCallId, toolName: event.toolName, input: event.input ?? {} }
        : { kind: "ignored" };
    case "tool_running":
      return event.toolCallId && event.toolName
        ? { kind: "tool_running", toolCallId: event.toolCallId, toolName: event.toolName }
        : { kind: "ignored" };
    case "tool_completed":
      return event.toolCallId && event.toolName
        ? {
            kind: "tool_completed",
            toolCallId: event.toolCallId,
            toolName: event.toolName,
            resultText: resultTextOf(event.result),
          }
        : { kind: "ignored" };
    case "turn_end":
      return {
        kind: "turn_end",
        usage: {
          inputTokens: event.usage?.inputTokens,
          outputTokens: event.usage?.outputTokens,
        },
      };
    case "run_end": {
      // Nested run_end event carries the result summary.
      const summary = (event as { result?: { finalText?: string } }).result;
      return {
        kind: "run_end",
        sessionId: event.sessionId ?? "",
        finalText: summary?.finalText ?? event.finalText ?? "",
      };
    }
    default:
      return { kind: "ignored" };
  }
}

export interface TaskItem {
  id: string;
  text: string;
  status: "pending" | "in_progress" | "completed";
  activeForm?: string;
}

// ponytail: task_list prints "#1 [in_progress] Write docs" per line
export function parseTaskList(text: string): TaskItem[] {
  const items: TaskItem[] = [];
  for (const line of text.split("\n")) {
    const match = /^#([A-Za-z0-9_-]+)\s+\[(pending|in_progress|completed)\]\s+(.+?)\s*$/.exec(line.trim());
    if (match) items.push({ id: match[1], text: match[3], status: match[2] as TaskItem["status"] });
  }
  return items;
}

// ponytail: task_get prints "Task #1: title" + "Status: in_progress"
export function parseTaskGet(text: string): TaskItem | null {
  const id = /^Task #([A-Za-z0-9_-]+):\s*(.+?)\s*$/m.exec(text)?.[1];
  const title = /^Task #[A-Za-z0-9_-]+:\s*(.+?)\s*$/m.exec(text)?.[1];
  const status = /^Status:\s*(\S+)\s*$/m.exec(text)?.[1];
  if (!id || !title) return null;
  if (status !== "pending" && status !== "in_progress" && status !== "completed") return null;
  return { id, text: title, status };
}

// ponytail: "Task #1 created: ..." / "Updated task #1: ..." carry the numeric id
export function parseTaskId(text: string): string | null {
  return /(?:Task|task) #([A-Za-z0-9_-]+)/.exec(text)?.[1] ?? null;
}

export interface RunFlags {
  model?: string;
  effort?: string;
  plan?: boolean;
  yolo?: boolean;
  resumeSessionId?: string;
}

export function buildArgs(flags: RunFlags, text: string): string[] {
  const args = ["-p", "--output-format", "json", "--trust"];
  if (flags.model) args.push("--model", flags.model);
  // Omit --effort unless explicitly chosen: valid levels are per-model
  // (e.g. deepseek flash accepts only high/max), and CLI errors on others.
  if (flags.effort) args.push("--effort", flags.effort);
  if (flags.plan) args.push("--plan");
  // ponytail: --auto-accept is a no-op for withheld headless tools
  // (write/shell stay hook-blocked); only --yolo unlocks them.
  // --tools-all un-withholds the rest.
  if (flags.yolo) args.push("--yolo", "--tools-all");
  if (flags.resumeSessionId) args.push("--session", flags.resumeSessionId);
  args.push(text);
  return args;
}
