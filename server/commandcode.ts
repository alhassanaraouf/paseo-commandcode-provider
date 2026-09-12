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

export interface RunFlags {
  model?: string;
  effort?: string;
  plan?: boolean;
  autoAccept?: boolean;
  resumeSessionId?: string;
}

export function buildArgs(flags: RunFlags, text: string): string[] {
  const args = ["-p", "--output-format", "json", "--trust"];
  if (flags.model) args.push("--model", flags.model);
  // Omit --effort unless explicitly chosen: valid levels are per-model
  // (e.g. deepseek flash accepts only high/max), and CLI errors on others.
  if (flags.effort) args.push("--effort", flags.effort);
  if (flags.plan) args.push("--plan");
  if (flags.autoAccept) args.push("--auto-accept");
  if (flags.resumeSessionId) args.push("--session", flags.resumeSessionId);
  args.push(text);
  return args;
}
