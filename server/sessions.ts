/** List and hydrate native `commandcode` sessions for Paseo import. */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type {
  ProviderSessionSummary,
  ProviderTimelineItem,
  ProviderToolCallDetail,
} from "@getpaseo/plugin/server/provider";

type UnknownToolInput = Extract<ProviderToolCallDetail, { type: "unknown" }>["input"];

const MAX_TRANSCRIPT_BYTES = 5 * 1024 * 1024;
const MAX_SUMMARY_LINES = 400;
const MAX_SUMMARY_BYTES = 1024 * 1024;

export function nativeProjectsDir(): string {
  return join(homedir(), ".commandcode", "projects");
}

interface NativeSummary {
  sessionId: string;
  cwd: string;
  firstPrompt?: string;
  lastText?: string;
  lastAt?: string;
  model?: string;
  mtimeMs: number;
}

function readSlice(path: string, maxBytes: number): string | null {
  try {
    const stat = statSync(path);
    if (stat.size > maxBytes * 4) return null;
    const raw = readFileSync(path, "utf8");
    return raw.length > maxBytes ? raw.slice(-maxBytes) : raw;
  } catch {
    return null;
  }
}

function readSummary(path: string): NativeSummary | null {
  const stat = (() => {
    try {
      return statSync(path);
    } catch {
      return null;
    }
  })();
  if (!stat) return null;
  const raw = readSlice(path, MAX_SUMMARY_BYTES);
  if (raw === null) {
    return { sessionId: "", cwd: "", mtimeMs: stat.mtimeMs };
  }
  try {
    const lines = raw.split("\n");
    let sessionId: string | undefined;
    let cwd = "";
    let firstPrompt: string | undefined;
    let lastText: string | undefined;
    let lastAt: string | undefined;
    let model: string | undefined;
    let count = 0;
    for (const line of lines) {
      if (!line.trim()) continue;
      let record: Record<string, unknown>;
      try {
        record = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (record.type === "session") {
        if (typeof record.id === "string") sessionId = record.id;
        if (typeof record.cwd === "string") cwd = record.cwd;
        continue;
      }
      if (record.type !== "message") continue;
      const message = record.message as { role?: string; content?: Array<{ type?: string; text?: string }> } | undefined;
      if (!message || !Array.isArray(message.content)) continue;
      if (record.usage && typeof record.model === "string") model = record.model as string;
      else if (typeof record.model === "string") model = model ?? (record.model as string);
      if (typeof record.timestamp === "string") lastAt = record.timestamp as string;
      const text = message.content
        .filter((part) => part?.type === "text" && typeof part.text === "string")
        .map((part) => part.text as string)
        .join("\n")
        .trim();
      if (!text) continue;
      if (message.role === "user" && !firstPrompt) firstPrompt = text;
      if (message.role === "assistant") lastText = text;
      if (++count > MAX_SUMMARY_LINES) break;
    }
    if (!sessionId) return null;
    return { sessionId, cwd, firstPrompt, lastText, lastAt, model, mtimeMs: stat.mtimeMs };
  } catch {
    return null;
  }
}

export function findNativeSessionFile(sessionId: string): string | null {
  // ponytail: filenames are <sessionId>.jsonl, so a direct directory scan beats
  // spawning the CLI or keeping an index.
  let projects: string[];
  try {
    projects = readdirSync(nativeProjectsDir(), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return null;
  }
  for (const project of projects) {
    const candidate = join(nativeProjectsDir(), project, `${sessionId}.jsonl`);
    try {
      statSync(candidate);
      return candidate;
    } catch {
      // not in this project dir
    }
  }
  return null;
}

export interface ListNativeOptions {
  query?: string;
  cwd?: string;
  limit?: number;
}

export function listNativeSessions(options: ListNativeOptions = {}): ProviderSessionSummary[] {
  const limit = options.limit ?? 20;
  const query = options.query?.trim().toLowerCase();
  let projects: string[];
  try {
    projects = readdirSync(nativeProjectsDir(), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
  const files: Array<{ path: string; mtimeMs: number }> = [];
  for (const project of projects) {
    let entries: string[];
    try {
      entries = readdirSync(join(nativeProjectsDir(), project));
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.endsWith(".jsonl") || entry.includes("checkpoints")) continue;
      const path = join(nativeProjectsDir(), project, entry);
      try {
        files.push({ path, mtimeMs: statSync(path).mtimeMs });
      } catch {
        // skip unreadable files
      }
    }
  }
  files.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const summaries: ProviderSessionSummary[] = [];
  for (const file of files.slice(0, Math.min(files.length, Math.max(limit * 10, 100)))) {
    const summary = readSummary(file.path);
    if (!summary) continue;
    if (options.cwd && summary.cwd && summary.cwd !== options.cwd && !summary.cwd.startsWith(options.cwd)) continue;
    if (query) {
      const haystack = [summary.sessionId, summary.cwd, summary.firstPrompt ?? "", summary.lastText ?? ""]
        .join("\n")
        .toLowerCase();
      if (!haystack.includes(query)) continue;
    }
    summaries.push({
      persistence: { version: 1, data: { sessionId: summary.sessionId } },
      cwd: summary.cwd || options.cwd || "",
      ...(summary.firstPrompt ? { title: summary.firstPrompt.slice(0, 80) } : {}),
      ...(summary.lastText ? { description: summary.lastText.slice(0, 200) } : {}),
      updatedAt: summary.lastAt ?? new Date(summary.mtimeMs).toISOString(),
    });
    if (summaries.length >= limit) break;
  }
  return summaries;
}

function truncate(text: string, max = 8000): string {
  return text.length > max ? `${text.slice(0, max)}\n…(truncated)` : text;
}

export function toolDetail(
  name: string,
  input: Record<string, unknown>,
  resultText?: string,
): ProviderToolCallDetail {
  const stringField = (...keys: string[]): string | undefined => {
    for (const key of keys) {
      const value = input[key];
      if (typeof value === "string" && value) return value;
    }
    return undefined;
  };
  const path = stringField("path", "file_path", "filePath");
  const rest: Record<string, unknown> = { ...input };
  if (/^(read|edit|write|search|fetch|shell|run|exec|bash|terminal|glob|grep|find|list|web|http|curl)/i.test(name)) {
    if (/read|list|directory|catalog/i.test(name)) {
      return { type: "read", filePath: path ?? "(unknown path)", content: resultText };
    }
    if (/edit|apply|patch/i.test(name)) {
      return { type: "edit", filePath: path ?? "(unknown path)", newString: resultText };
    }
    if (/write|create|save/i.test(name)) {
      return { type: "write", filePath: path ?? "(unknown path)", content: resultText };
    }
    if (/search|grep|glob|find/i.test(name)) {
      return { type: "search", query: stringField("query", "pattern", "text") ?? name, content: resultText };
    }
    if (/fetch|web|curl|http/i.test(name)) {
      return { type: "fetch", url: stringField("url") ?? "(unknown url)", result: resultText };
    }
    if (/run|exec|shell|command|bash|terminal/i.test(name)) {
      return { type: "shell", command: stringField("command") ?? name, output: resultText, exitCode: null };
    }
  }
  return { type: "unknown", input: rest as UnknownToolInput, output: resultText ?? "" };
}

/** Replay a native transcript file as provider timeline snapshots. */
export function readNativeTranscript(sessionId: string): { items: ProviderTimelineItem[]; tasks: Array<{ id: string; text: string; status: "pending" | "in_progress" | "completed" }> } {
  const path = findNativeSessionFile(sessionId);
  if (!path) return { items: [], tasks: [] };
  const raw = readSlice(path, MAX_TRANSCRIPT_BYTES);
  if (raw === null) return { items: [], tasks: [] };
  const toolResults = new Map<string, string>();
  const records: Array<{ id: string; role: string; content: Array<Record<string, unknown>> }> = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let record: Record<string, unknown>;
    try {
      record = JSON.parse(line) as Record<string, unknown>;
    } catch {
      continue;
    }
    if (record.type !== "message") continue;
    const message = record.message as { role?: unknown; content?: unknown } | undefined;
    if (!message || typeof message.role !== "string" || !Array.isArray(message.content)) continue;
    const id = typeof record.id === "string" ? record.id : String(records.length);
    records.push({ id, role: message.role, content: message.content as Array<Record<string, unknown>> });
  }
  for (const record of records) {
    if (record.role !== "user") continue;
    for (const part of record.content) {
      if (part.type !== "tool_result" || typeof part.tool_use_id !== "string") continue;
      const text = Array.isArray(part.content)
        ? (part.content as Array<{ type?: string; text?: string }>)
            .filter((chunk) => chunk?.type === "text" && typeof chunk.text === "string")
            .map((chunk) => chunk.text as string)
            .join("\n")
        : "";
      toolResults.set(part.tool_use_id as string, text);
    }
  }
  const items: ProviderTimelineItem[] = [];
  const tasks = new Map<string, { text: string; status: "pending" | "in_progress" | "completed" }>();
  for (const record of records) {
    if (record.role === "user") {
      const text = record.content
        .filter((part) => part.type === "text" && typeof part.text === "string")
        .map((part) => part.text as string)
        .join("\n")
        .trim();
      if (text) items.push({ type: "user_message", id: `user-${record.id}`, text: truncate(text) });
      continue;
    }
    if (record.role !== "assistant") continue;
    const thinking = record.content
      .filter((part) => part.type === "thinking" && typeof part.thinking === "string")
      .map((part) => part.thinking as string)
      .join("\n")
      .trim();
    if (thinking) items.push({ type: "reasoning", id: `reasoning-${record.id}`, text: truncate(thinking) });
    const text = record.content
      .filter((part) => part.type === "text" && typeof part.text === "string")
      .map((part) => part.text as string)
      .join("\n")
      .trim();
    if (text) items.push({ type: "assistant_message", id: `assistant-${record.id}`, text: truncate(text) });
    for (const part of record.content) {
      if (part.type !== "tool_use" || typeof part.id !== "string" || typeof part.name !== "string") continue;
      const input = (part.input as Record<string, unknown> | undefined) ?? {};
      const result = toolResults.get(part.id as string);
      items.push({
        type: "tool_call",
        id: part.id as string,
        callId: part.id as string,
        name: part.name as string,
        detail: toolDetail(part.name as string, input, result ? truncate(result) : undefined),
        status: "completed",
        error: null,
      });
      trackReplayedTask(tasks, part.name as string, input, result ?? "");
    }
  }
  if (tasks.size > 0) {
    items.push({
      type: "todo",
      id: "tasks",
      items: [...tasks.entries()].map(([id, task]) => ({
        id,
        text: task.text,
        completed: task.status === "completed",
        status: task.status,
      })),
    });
  }
  return { items, tasks: [...tasks.entries()].map(([id, task]) => ({ id, ...task })) };
}

function trackReplayedTask(
  tasks: Map<string, { text: string; status: "pending" | "in_progress" | "completed" }>,
  name: string,
  input: Record<string, unknown>,
  resultText: string,
): void {
  const statusOf = (value: unknown): "pending" | "in_progress" | "completed" | undefined =>
    value === "pending" || value === "in_progress" || value === "completed" ? value : undefined;
  if (name === "task_list") {
    for (const line of resultText.split("\n")) {
      const match = /^#([A-Za-z0-9_-]+)\s+\[(pending|in_progress|completed)\]\s+(.+?)\s*$/.exec(line.trim());
      if (match) tasks.set(match[1], { text: match[3], status: match[2] as "pending" | "in_progress" | "completed" });
    }
    return;
  }
  if (name === "task_create" || name === "task_update") {
    const id = typeof input.taskId === "string" && input.taskId
      ? input.taskId
      : /(?:Task|task) #([A-Za-z0-9_-]+)/.exec(resultText)?.[1];
    if (!id) return;
    if (name === "task_update" && input.status === "deleted") {
      tasks.delete(id);
      return;
    }
    const subject = typeof input.subject === "string" && input.subject
      ? input.subject
      : typeof input.description === "string" && input.description
        ? input.description
        : /^Task #\S+ created:\s*(.+?)\s*$/.exec(resultText)?.[1];
    const status = statusOf(input.status) ?? tasks.get(id)?.status ?? "pending";
    tasks.set(id, { text: subject ?? tasks.get(id)?.text ?? `Task ${id}`, status });
  }
}
