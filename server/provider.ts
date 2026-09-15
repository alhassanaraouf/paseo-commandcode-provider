import { execFile as nodeExecFile, spawn as nodeSpawn, type ExecFileOptions } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import {
  negotiateProviderCapabilities,
  requireProviderCapabilities,
  type ProviderCapability,
  type ProviderConfigState,
  type ProviderConnection,
  type ProviderContent,
  type ProviderEvent,
  type ProviderInput,
  type ProviderPersistence,
  type ProviderRegistration,
  type ProviderSessionConfig,
  type ProviderTimelineItem,
  type ProviderToolCallDetail,
} from "@getpaseo/plugin/server/provider";
import { buildArgs, parseLine, type RunFlags } from "./commandcode.js";
import { commandArgv, COMMANDS, findCommand } from "./commands.js";
import { FALLBACK_DEFAULT, FALLBACK_MODELS, parseListModels, type ModelInfo } from "./models.js";
import { parseSkillsList, type SkillInfo } from "./skills.js";
import { readSettingsDocument } from "./settings.js";
import { CLI_DEFAULTS, cliSettings } from "../shared/settings.js";

const CAPABILITIES = [
  "prompt.message",
  "prompt.command",
  "session.configure",
  "session.persistence",
] as const;

const DEFAULT_MODEL = FALLBACK_DEFAULT;

// ponytail: effort levels are per-model (e.g. deepseek flash takes only high/max),
// so no default is advertised and --effort is omitted unless explicitly chosen
const EFFORTS = [
  { id: "low", label: "Low" },
  { id: "medium", label: "Medium" },
  { id: "high", label: "High" },
  { id: "max", label: "Max" },
] as const;

export interface ProcStdio {
  on(event: "data", listener: (chunk: Buffer | string) => void): void;
}

export interface Proc {
  stdout: ProcStdio | null;
  stderr: ProcStdio | null;
  // ponytail: untyped event bridge to Node ChildProcess, tighten if it grows
  on(event: string, listener: (...args: never[]) => void): void;
  kill(signal?: string): void;
}

export type SpawnFn = (
  command: string,
  args: string[],
  options: { cwd: string; env: Record<string, string> },
) => Proc;

export interface ExecResult {
  stdout: string;
  stderr: string;
}

export type ExecFn = (
  command: string,
  args: string[],
  options: { cwd: string; env: Record<string, string>; timeoutMs: number },
) => Promise<ExecResult>;

function defaultSpawn(
  command: string,
  args: string[],
  options: { cwd: string; env: Record<string, string> },
): Proc {
  const child = nodeSpawn(command, args, { cwd: options.cwd, env: options.env });
  return {
    stdout: child.stdout,
    stderr: child.stderr,
    on: child.on.bind(child) as Proc["on"],
    kill: (signal) => {
      child.kill(signal as NodeJS.Signals | undefined);
    },
  };
}

interface Session {
  config: ProviderSessionConfig;
  nativeSessionId: string | null;
  transcript: ProviderTimelineItem[];
  active: { turnId: string; proc: Proc } | null;
}

interface ModelsCache {
  models: ModelInfo[];
  defaultModel: string;
  fetchedAt: number;
}

interface ConnectionState {
  sessions: Map<string, Session>;
  emit(event: ProviderEvent): void;
  command: string;
  spawn: SpawnFn;
  exec: ExecFn;
  listModels: () => Promise<string>;
  listSkills: () => Promise<string>;
  models: ModelInfo[];
  defaultModel: string;
  modelsFetchedAt: number;
  cache: ModelsCache;
  skills: Map<string, SkillInfo>;
  skillsFetchedAt: number;
}

const MODELS_TTL_MS = 60 * 60 * 1000;

const execFileAsync = promisify(nodeExecFile);

async function runListModels(command: string): Promise<string> {
  const { stdout } = await execFileAsync(command, ["--list-models"], { timeout: 30_000 });
  return stdout;
}

async function runListSkills(command: string): Promise<string> {
  const { stdout } = await execFileAsync(command, ["skills", "list"], { timeout: 30_000 });
  return stdout;
}

function defaultExec(
  command: string,
  args: string[],
  options: { cwd: string; env: Record<string, string>; timeoutMs: number },
): Promise<ExecResult> {
  return execFileAsync(command, args, {
    cwd: options.cwd,
    env: options.env,
    timeout: options.timeoutMs,
    maxBuffer: 1024 * 1024,
  } as ExecFileOptions).then(
    ({ stdout, stderr }) => ({ stdout: String(stdout), stderr: String(stderr) }),
    (error: unknown) => {
      // ponytail: surface CLI stdout/stderr on failure instead of a bare exit code
      const stdout = typeof (error as { stdout?: unknown }).stdout === "string" ? (error as { stdout: string }).stdout : "";
      const stderr = typeof (error as { stderr?: unknown }).stderr === "string" ? (error as { stderr: string }).stderr : "";
      const message = error instanceof Error ? error.message : String(error);
      const detail = [stdout, stderr].map((part) => part.trim()).filter(Boolean).join("\n");
      throw new Error(detail || message);
    },
  );
}

export function createCommandcodeProvider(options?: {
  command?: string;
  spawn?: SpawnFn;
  exec?: ExecFn;
  listModels?: () => Promise<string>;
  listSkills?: () => Promise<string>;
  modelsCache?: ModelsCache;
}): ProviderRegistration {
  return {
    id: "commandcode",
    label: "Command Code",
    description: "Command Code coding agent (headless via `commandcode -p`)",
    icon: "icon.svg",
    async connect(request) {
      if (!request.versions.includes(1)) {
        throw new Error("Provider protocol version 1 is required");
      }
      const capabilities = negotiateProviderCapabilities(
        request.capabilities,
        CAPABILITIES as unknown as readonly ProviderCapability[],
      );
      // ponytail: "cmd" is the Windows shell, so the npm package publishes "cmdc"
      // as its short alias there; "commandcode" is the cross-platform full name.
      const platformDefault = process.platform === "win32" ? "cmdc" : "commandcode";
      const configured = readSettingsDocument(cliSettings, CLI_DEFAULTS).command.trim();
      const command = options?.command ?? (configured || platformDefault);
      return createConnection(capabilities, {
        command,
        spawn: options?.spawn ?? defaultSpawn,
        exec: options?.exec ?? defaultExec,
        listModels: options?.listModels ?? (() => runListModels(command)),
        listSkills: options?.listSkills ?? (() => runListSkills(command)),
        cache: options?.modelsCache ?? createModelsCache(),
      });
    },
  };
}

function createConnection(
  capabilities: readonly string[],
  options: { command: string; spawn: SpawnFn; exec: ExecFn; listModels: () => Promise<string>; listSkills: () => Promise<string>; cache: ModelsCache },
): ProviderConnection {
  const listeners = new Set<(event: ProviderEvent) => void>();
  const sessions = new Map<string, Session>();
  let closed = false;
  const state: ConnectionState = {
    sessions,
    emit: (event) => {
      if (closed) return;
      for (const listener of listeners) listener(event);
    },
    command: options.command,
    spawn: options.spawn,
    exec: options.exec,
    listModels: options.listModels,
    listSkills: options.listSkills,
    models: options.cache.models,
    defaultModel: options.cache.defaultModel,
    modelsFetchedAt: 0,
    cache: options.cache,
    skills: new Map(),
    skillsFetchedAt: 0,
  };

  return {
    version: 1,
    capabilities,
    async send(input: ProviderInput) {
      if (closed) throw new Error("Provider connection is closed");
      requireProviderCapabilities(capabilities, input);
      if (input.type === "session.open" && sessions.has(input.sessionId)) {
        throw new Error(`Session already exists: ${input.sessionId}`);
      }
      if ("sessionId" in input && input.type !== "session.open" && !sessions.has(input.sessionId)) {
        throw new Error(`Unknown session: ${input.sessionId}`);
      }
      queueMicrotask(() => {
        if (!closed) dispatch(input, state);
      });
    },
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async close() {
      if (closed) return;
      closed = true;
      for (const session of sessions.values()) session.active?.proc.kill();
      sessions.clear();
      listeners.clear();
    },
  };
}

// ponytail: per-provider cache so every connection/open reuses the last good
// list without re-running the ~4s CLI call; falls back to the static list
function createModelsCache(): ModelsCache {
  return { models: FALLBACK_MODELS, defaultModel: DEFAULT_MODEL, fetchedAt: 0 };
}

async function refreshModels(state: ConnectionState): Promise<boolean> {
  if (Date.now() - state.cache.fetchedAt < MODELS_TTL_MS && state.cache.fetchedAt > 0) {
    state.models = state.cache.models;
    state.defaultModel = state.cache.defaultModel;
    state.modelsFetchedAt = Date.now();
    return false;
  }
  if (Date.now() - state.modelsFetchedAt < MODELS_TTL_MS) return false;
  try {
    const { models, defaultId } = parseListModels(await state.listModels());
    if (models.length > 0) {
      state.models = models;
      state.cache.models = models;
      if (defaultId) {
        state.defaultModel = defaultId;
        state.cache.defaultModel = defaultId;
      }
      state.modelsFetchedAt = Date.now();
      state.cache.fetchedAt = Date.now();
      return true;
    }
  } catch {
    // keep fallback / cached list
  }
  return false;
}

async function refreshSkills(state: ConnectionState): Promise<boolean> {
  if (Date.now() - state.skillsFetchedAt < MODELS_TTL_MS && state.skillsFetchedAt > 0) return false;
  try {
    const parsed = parseSkillsList(await state.listSkills());
    const next = new Map(parsed.map((skill) => [skill.name, skill] as const));
    const changed =
      next.size !== state.skills.size ||
      [...next.keys()].some((name) => {
        const prev = state.skills.get(name);
        const cur = next.get(name);
        return prev?.description !== cur?.description;
      });
    state.skills = next;
    state.skillsFetchedAt = Date.now();
    return changed;
  } catch {
    return false;
  }
}

// ponytail: shared Build/Plan catalog+config modes, keep identical in both places
const MODES = [
  { id: "build", label: "Build" },
  { id: "plan", label: "Plan" },
] as const;

function modelsView(models: ModelInfo[]) {
  return models.map((model) => ({ id: model.id, label: model.label, ...(model.description ? { description: model.description } : {}) }));
}

function commandsView(state?: ConnectionState) {
  const base = COMMANDS.map((command) => ({
    name: command.name,
    description: command.description,
    ...(command.argumentHint ? { argumentHint: command.argumentHint } : {}),
  }));
  if (!state) return base;
  for (const skill of state.skills.values()) {
    if (base.some((command) => command.name === skill.name)) continue;
    base.push({
      name: skill.name,
      description: skill.description ?? `Invoke the ${skill.name} skill`,
    });
  }
  return base;
}

function catalogState(state: ConnectionState) {
  return {
    models: modelsView(state.models),
    modes: MODES.map((mode) => ({ ...mode })),
    thinkingOptions: EFFORTS.map((effort) => ({ ...effort })),
    defaultModel: state.defaultModel,
    defaultMode: "build",
  };
}

function dispatch(input: ProviderInput, state: ConnectionState): void {
  switch (input.type) {
    case "catalog":
      void refreshModels(state).then(() => {
        state.emit({ type: "catalog", requestId: input.requestId, catalog: catalogState(state) });
      });
      return;
    case "session.open":
      openSession(input, state);
      return;
    case "session.prompt":
      promptSession(input, state);
      return;
    case "session.configure":
      configureSession(input, state);
      return;
    case "session.interrupt": {
      const session = state.sessions.get(input.sessionId);
      session?.active?.proc.kill();
      state.emit({ type: "request.completed", requestId: input.requestId });
      return;
    }
    case "session.close":
      state.sessions.get(input.sessionId)?.active?.proc.kill();
      state.sessions.delete(input.sessionId);
      state.emit({ type: "session.closed", sessionId: input.sessionId });
      state.emit({ type: "request.completed", requestId: input.requestId });
      return;
    default:
      return;
  }
}

function resumeId(persistence: ProviderPersistence | undefined): string | null {
  const data = persistence?.data;
  if (typeof data === "object" && data !== null && !Array.isArray(data)) {
    const sessionId = (data as Record<string, unknown>).sessionId;
    return typeof sessionId === "string" ? sessionId : null;
  }
  return null;
}

function openSession(
  input: Extract<ProviderInput, { type: "session.open" }>,
  state: ConnectionState,
): void {
  const session: Session = {
    config: input.config,
    nativeSessionId: resumeId(input.persistence),
    transcript: [],
    active: null,
  };
  state.sessions.set(input.sessionId, session);
  state.emit({
    type: "session.opened",
    requestId: input.requestId,
    sessionId: input.sessionId,
    capabilities: ["prompt.message", "prompt.command", "session.configure", "session.persistence"],
    restoration: "core",
    ...(session.nativeSessionId
      ? { persistence: { version: 1, data: { sessionId: session.nativeSessionId } } }
      : {}),
    title: input.config.title,
    cwd: input.config.cwd,
  });
  // ponytail: emit config+commands synchronously so the composer mounts complete;
  // re-emit only when the background refresh actually changed the model list
  state.emit({ type: "session.config", sessionId: input.sessionId, config: configState(session, state) });
  state.emit({ type: "session.commands", sessionId: input.sessionId, commands: commandsView(state) });
  void refreshModels(state).then((changed) => {
    if (!changed) return;
    state.emit({ type: "session.config", sessionId: input.sessionId, config: configState(session, state) });
  });
  void refreshSkills(state).then((changed) => {
    if (!changed) return;
    state.emit({ type: "session.commands", sessionId: input.sessionId, commands: commandsView(state) });
  });
  if (input.history === "replay") {
    for (const item of session.transcript) {
      state.emit({ type: "timeline.item", sessionId: input.sessionId, item });
    }
  }
  state.emit({ type: "session.ready", requestId: input.requestId, sessionId: input.sessionId });
}

function settingValue(
  settings: Readonly<Record<string, unknown>>,
  id: string,
): string | boolean | undefined {
  const value = settings[id];
  return typeof value === "string" || typeof value === "boolean" ? value : undefined;
}

function isYolo(settings: Readonly<Record<string, unknown>>): boolean {
  // ponytail: legacy autoAccept values (bool or on/off) map to yolo;
  // --auto-accept never unlocked headless writes, --yolo does
  const value = settings.yolo ?? settings.autoAccept;
  return value === true || value === "on";
}

// ponytail: lets a user point at a custom binary (path, cmdc, a wrapper
// script) via the agent's standard env vars, no dedicated settings UI needed
function commandFor(session: Session, state: ConnectionState): string {
  return session.config.env.COMMANDCODE_CLI_COMMAND?.trim() || state.command;
}

function effortOf(session: Session): string | undefined {
  // ponytail: effort lives only in the native Thinking pill (thinkingOptions);
  // the custom select was a duplicate, so settings are ignored here
  const raw = session.config.thinkingOption;
  return typeof raw === "string" && EFFORTS.some((effort) => effort.id === raw) ? raw : undefined;
}

function configState(session: Session, state?: ConnectionState): ProviderConfigState {
  const settings = session.config.settings as Record<string, unknown>;
  const effort = effortOf(session);
  const models = state?.models ?? FALLBACK_MODELS;
  const defaultModel = state?.defaultModel ?? DEFAULT_MODEL;
  return {
    model: session.config.model ?? defaultModel,
    mode: session.config.mode ?? "build",
    thinkingOption: effort,
    models: modelsView(models),
    modes: MODES.map((mode) => ({ ...mode })),
    thinkingOptions: EFFORTS.map((option) => ({ ...option })),
    // ponytail: single permission knob as a select so state shows beside
    // the label. --auto-accept can't unlock headless writes, so this drives
    // --yolo --tools-all, labeled honestly.
    settings: [
      {
        type: "select",
        id: "yolo",
        label: "Full auto (yolo, skips all permission checks)",
        value: isYolo(settings) ? "on" : "off",
        options: [
          { label: "On", value: "on" },
          { label: "Off", value: "off" },
        ],
      },
    ],
  };
}

function configureSession(
  input: Extract<ProviderInput, { type: "session.configure" }>,
  state: ConnectionState,
): void {
  const session = state.sessions.get(input.sessionId);
  if (!session) {
    state.emit({
      type: "request.failed",
      requestId: input.requestId,
      error: { message: `Unknown session: ${input.sessionId}` },
    });
    return;
  }
  const changes = input.changes;
  session.config = {
    ...session.config,
    model: changes.model === null ? undefined : (changes.model ?? session.config.model),
    mode: changes.mode === null ? undefined : (changes.mode ?? session.config.mode),
    thinkingOption:
      changes.thinkingOption === null
        ? undefined
        : (changes.thinkingOption ?? session.config.thinkingOption),
    settings: changes.settings
      ? { ...session.config.settings, ...changes.settings }
      : session.config.settings,
  };
  state.emit({ type: "session.config", sessionId: input.sessionId, config: configState(session, state) });
  state.emit({
    type: "session.commands",
    sessionId: input.sessionId,
    commands: commandsView(state),
  });
  state.emit({ type: "request.completed", requestId: input.requestId });
}

function promptText(content: ProviderContent[]): { text: string; hasImage: boolean } {
  let text = "";
  let hasImage = false;
  for (const part of content) {
    if (part.type === "text") text += (text ? "\n" : "") + part.text;
    else if (part.type === "image") hasImage = true;
  }
  return { text, hasImage };
}

function flagsFor(session: Session): RunFlags {
  const settings = session.config.settings as Record<string, unknown>;
  const effort = effortOf(session);
  return {
    model: session.config.model ?? undefined,
    effort,
    plan: session.config.mode === "plan",
    yolo: isYolo(settings),
    resumeSessionId: session.nativeSessionId ?? undefined,
  };
}

function promptSession(
  input: Extract<ProviderInput, { type: "session.prompt" }>,
  state: ConnectionState,
): void {
  const session = state.sessions.get(input.sessionId);
  const fail = (message: string) => {
    state.emit({
      type: "session.prompt_result",
      sessionId: input.sessionId,
      clientMessageId: input.prompt.clientMessageId,
      result: { type: "failed", error: { message } },
    });
  };
  if (!session) {
    fail(`Unknown session: ${input.sessionId}`);
    return;
  }
  if (input.prompt.delivery === "steer") {
    fail("Steering is not supported; wait for the turn to finish");
    return;
  }
  if (input.prompt.input.type === "command") {
    runSlashCommand(input.sessionId, session, input.prompt.clientMessageId, input.prompt.input.name, input.prompt.input.arguments, state);
    return;
  }
  const { text, hasImage } = promptText(input.prompt.input.content);
  if (hasImage) {
    fail("Images are not supported by this provider");
    return;
  }
  if (!text.trim()) {
    fail("Empty prompt");
    return;
  }
  runAgentTurn(input.sessionId, session, input.prompt.clientMessageId, text, state);
}

function runSlashCommand(
  sessionId: string,
  session: Session,
  clientMessageId: string,
  name: string,
  args: string,
  state: ConnectionState,
): void {
  if (findCommand(name)) {
    runCommand(sessionId, session, clientMessageId, name, args, state);
    return;
  }
  if (state.skills.has(name)) {
    // ponytail: installed skills are first-class slash commands in the CLI,
    // so run them as an agent turn: `commandcode -p "/skill args"`.
    const text = args.trim() ? `/${name} ${args.trim()}` : `/${name}`;
    runAgentTurn(sessionId, session, clientMessageId, text, state);
    return;
  }
  // ponytail: skills load in the background at session.open, so a fast
  // typist can beat the refresh — retry once before reporting unknown.
  void refreshSkills(state).then((changed) => {
    if (changed) {
      state.emit({ type: "session.commands", sessionId, commands: commandsView(state) });
    }
    if (state.skills.has(name)) {
      const text = args.trim() ? `/${name} ${args.trim()}` : `/${name}`;
      runAgentTurn(sessionId, session, clientMessageId, text, state);
      return;
    }
    state.emit({
      type: "session.prompt_result",
      sessionId,
      clientMessageId,
      result: { type: "failed", error: { message: `Unknown command: /${name}` } },
    });
  });
}

function runAgentTurn(
  sessionId: string,
  session: Session,
  clientMessageId: string,
  text: string,
  state: ConnectionState,
): void {
  const fail = (message: string) => {
    state.emit({
      type: "session.prompt_result",
      sessionId,
      clientMessageId,
      result: { type: "failed", error: { message } },
    });
  };
  if (session.active) {
    fail("A turn is already running");
    return;
  }

  const turnId = randomUUID();
  const push = (item: ProviderTimelineItem) => {
    session.transcript.push(item);
    state.emit({ type: "timeline.item", sessionId, item });
  };
  push({
    type: "user_message",
    id: `user-${turnId}`,
    text,
    clientMessageId,
  });
  state.emit({
    type: "session.prompt_result",
    sessionId,
    clientMessageId,
    result: { type: "turn", turnId },
  });
  state.emit({ type: "session.turn", sessionId, turnId, state: "started" });

  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  Object.assign(env, session.config.env);
  let proc: Proc;
  try {
    proc = state.spawn(commandFor(session, state), buildArgs(flagsFor(session), text), {
      cwd: session.config.cwd,
      env,
    });
  } catch (error) {
    state.emit({
      type: "session.turn",
      sessionId,
      turnId,
      state: "failed",
      error: { message: error instanceof Error ? error.message : String(error) },
    });
    return;
  }
  session.active = { turnId, proc };

  let assistantText = "";
  let thinkingText = "";
  let usage: { inputTokens?: number; outputTokens?: number } | undefined;
  let stderr = "";
  let finished = false;
  const tools = new Map<
    string,
    { name: string; input: Record<string, unknown>; resultText?: string; status: "running" }
  >();
  const finish = (terminal: "completed" | "failed" | "canceled", error?: string) => {
    if (finished) return;
    finished = true;
    session.active = null;
    state.emit({ type: "session.turn", sessionId, turnId, state: terminal, ...(error ? { error: { message: error } } : {}) });
  };

  let buffer = "";
  const onChunk = (chunk: Buffer | string) => {
    buffer += chunk.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      const parsed = parseLine(line);
      switch (parsed.kind) {
        case "run_start":
          session.nativeSessionId = parsed.sessionId;
          state.emit({
            type: "session.persistence",
            sessionId,
            persistence: { version: 1, data: { sessionId: parsed.sessionId } },
          });
          break;
        case "thinking_delta":
          thinkingText += parsed.delta;
          push({ type: "reasoning", id: `reasoning-${turnId}`, text: thinkingText });
          break;
        case "thinking_end":
          thinkingText = parsed.text;
          push({ type: "reasoning", id: `reasoning-${turnId}`, text: thinkingText });
          break;
        case "text_delta":
          assistantText += parsed.delta;
          push({ type: "assistant_message", id: `assistant-${turnId}`, text: assistantText });
          break;
        case "message_update":
          if (parsed.thinking && parsed.thinking !== thinkingText) {
            thinkingText = parsed.thinking;
            push({ type: "reasoning", id: `reasoning-${turnId}`, text: thinkingText });
          }
          if (parsed.text && parsed.text !== assistantText) {
            assistantText = parsed.text;
            push({ type: "assistant_message", id: `assistant-${turnId}`, text: assistantText });
          }
          break;
        case "tool_queued":
        case "tool_running": {
          const existing = tools.get(parsed.toolCallId) ?? {
            name: parsed.toolName,
            input: parsed.kind === "tool_queued" ? parsed.input : {},
            status: "running" as const,
          };
          tools.set(parsed.toolCallId, existing);
          push({
            type: "tool_call",
            id: parsed.toolCallId,
            callId: parsed.toolCallId,
            name: existing.name,
            detail: toolDetail(existing.name, existing.input),
            status: "running",
            error: null,
          });
          break;
        }
        case "tool_completed": {
          const existing = tools.get(parsed.toolCallId) ?? {
            name: parsed.toolName,
            input: {},
            status: "running" as const,
          };
          tools.set(parsed.toolCallId, { ...existing, resultText: parsed.resultText });
          push({
            type: "tool_call",
            id: parsed.toolCallId,
            callId: parsed.toolCallId,
            name: existing.name,
            detail: toolDetail(existing.name, existing.input, truncate(parsed.resultText)),
            status: "completed",
            error: null,
          });
          break;
        }
        case "turn_end":
          usage = parsed.usage;
          break;
        case "run_end": {
          if (parsed.sessionId) {
            session.nativeSessionId = parsed.sessionId;
            state.emit({
              type: "session.persistence",
              sessionId,
              persistence: { version: 1, data: { sessionId: parsed.sessionId } },
            });
          }
          if (!assistantText && parsed.finalText) {
            assistantText = parsed.finalText;
            push({ type: "assistant_message", id: `assistant-${turnId}`, text: assistantText });
          }
          if (usage && (usage.inputTokens !== undefined || usage.outputTokens !== undefined)) {
            state.emit({ type: "session.usage", sessionId, turnId, usage });
          }
          finish("completed");
          break;
        }
        case "ignored":
          break;
      }
    }
  };

  proc.stdout?.on("data", onChunk);
  proc.stderr?.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  proc.on("error", (error) => {
    push({ type: "error", id: `error-${turnId}`, message: String(error) });
    finish("failed", String(error));
  });
  proc.on("close", (code) => {
    if (finished) return;
    if (buffer.trim()) onChunk("\n");
    if (typeof code === "number" && code !== 0) {
      finish("failed", truncate(stderr, 500) || `commandcode exited with code ${code}`);
    } else {
      finish(assistantText ? "completed" : "failed", assistantText ? undefined : "No response");
    }
  });
}

function runCommand(
  sessionId: string,
  session: Session,
  clientMessageId: string,
  name: string,
  args: string,
  state: ConnectionState,
): void {
  const done = (result: { type: "completed" } | { type: "failed"; error: { message: string } }) => {
    state.emit({ type: "session.prompt_result", sessionId, clientMessageId, result });
  };
  const def = findCommand(name);
  if (!def) {
    done({ type: "failed", error: { message: `Unknown command: /${name}` } });
    return;
  }
  if (session.active && !def.allowWhileRunning) {
    done({ type: "failed", error: { message: `/${name} needs the active turn to finish first` } });
    return;
  }
  const argv = commandArgv(def, args);
  if (!Array.isArray(argv)) {
    done({ type: "failed", error: { message: argv.error } });
    return;
  }
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) env[key] = value;
  }
  Object.assign(env, session.config.env);
  void state
    .exec(commandFor(session, state), argv, { cwd: session.config.cwd, env, timeoutMs: 120_000 })
    .then(({ stdout, stderr }) => {
      const output = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n");
      if (def.showOutput) {
        state.emit({
          type: "session.notice",
          sessionId,
          notice: {
            id: `cmd-${clientMessageId}`,
            severity: "info",
            title: `/${name}`,
            description: truncate(output || "(no output)", 4000),
          },
        });
      }
      done({ type: "completed" });
    })
    .catch((error: unknown) => {
      done({
        type: "failed",
        error: { message: `/${name} failed: ${error instanceof Error ? error.message : String(error)}` },
      });
    });
}

function truncate(text: string, max = 8000): string {
  return text.length > max ? `${text.slice(0, max)}\n…(truncated)` : text;
}

function toolDetail(
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
  const path = stringField("path", "file_path", "filePath") ?? name;
  if (/read|list|directory|catalog/i.test(name)) {
    return { type: "read", filePath: path, content: resultText };
  }
  if (/edit|apply|patch/i.test(name)) {
    return { type: "edit", filePath: path, newString: resultText };
  }
  if (/write|create|save/i.test(name)) {
    return { type: "write", filePath: path, content: resultText };
  }
  if (/search|grep|glob|find/i.test(name)) {
    return { type: "search", query: stringField("query", "pattern", "text") ?? name, content: resultText };
  }
  if (/fetch|web|curl|http/i.test(name)) {
    return { type: "fetch", url: stringField("url") ?? name, result: resultText };
  }
  if (/run|exec|shell|command|bash|terminal/i.test(name)) {
    return { type: "shell", command: stringField("command") ?? name, output: resultText, exitCode: null };
  }
  return { type: "plain_text", label: name, text: resultText ?? "" };
}
