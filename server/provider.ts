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
} from "@getpaseo/plugin/server/provider";
import { buildArgs, parseLine, parseTaskGet, parseTaskId, parseTaskList, type RunFlags } from "./commandcode.js";
import { commandArgv, COMMANDS, findCommand } from "./commands.js";
import { parseListModels, type ModelInfo } from "./models.js";
import { listNativeSessions, readNativeTranscript, toolDetail } from "./sessions.js";
import { parseSkillsList, type SkillInfo } from "./skills.js";
import { readSettingsDocument } from "./settings.js";
import { CLI_DEFAULTS, cliSettings } from "../shared/settings.js";

const CAPABILITIES = [
  "prompt.message",
  "prompt.command",
  "session.configure",
  "session.list",
  "session.persistence",
] as const;

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
  active: { turnId: string; proc: Proc; interrupted: boolean } | null;
  tasks: Map<string, { text: string; status: "pending" | "in_progress" | "completed"; activeForm?: string }>;
  /** First user text, used as the session title when the host didn't provide one. */
  titleFromPrompt?: string;
}

interface ModelsCache {
  models: ModelInfo[];
  defaultModel?: string;
  fetchedAt: number;
}

interface ConnectionState {
  sessions: Map<string, Session>;
  emit(event: ProviderEvent): void;
  log(message: string): void;
  command: string;
  commandSource: "env" | "settings" | "default";
  health: HealthState;
  spawn: SpawnFn;
  exec: ExecFn;
  listModels: () => Promise<string>;
  listSkills: () => Promise<string>;
  models: ModelInfo[];
  defaultModel?: string;
  modelsFetchedAt: number;
  cache: ModelsCache;
  skills: Map<string, SkillInfo>;
  skillsFetchedAt: number;
}

interface HealthState {
  checked: boolean;
  ok: boolean;
  version?: string;
  error?: string;
  checkedAt: number;
}

const HEALTH_TTL_MS = 5 * 60 * 1000;
const MODELS_TTL_MS = 60 * 60 * 1000;
const STREAM_FLUSH_MS = 100;
const STREAM_FLUSH_CHARS = 500;

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
  log?: (message: string) => void;
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
      const platformDefault = process.platform === "win32" ? "cmdc" : "commandcode";
      const configured = readSettingsDocument(cliSettings, CLI_DEFAULTS).command.trim();
      const envOverride = process.env.COMMANDCODE_CLI_COMMAND?.trim();
      const command = options?.command ?? envOverride ?? (configured || platformDefault);
      const commandSource = options?.command ?? envOverride ? "env" : configured ? "settings" : "default";
      return createConnection(capabilities, {
        command,
        commandSource,
        log: options?.log ?? ((message) => console.error(`[commandcode-provider] ${message}`)),
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
  options: {
    command: string;
    commandSource: ConnectionState["commandSource"];
    log: (message: string) => void;
    spawn: SpawnFn;
    exec: ExecFn;
    listModels: () => Promise<string>;
    listSkills: () => Promise<string>;
    cache: ModelsCache;
  },
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
    log: options.log,
    command: options.command,
    commandSource: options.commandSource,
    health: { checked: false, ok: false, checkedAt: 0 },
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
// list without re-running the ~4s CLI call; starts empty until refreshed
function createModelsCache(): ModelsCache {
  return { models: [], defaultModel: undefined, fetchedAt: 0 };
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
    state.log(`list-models returned no models (binary: ${state.command})`);
  } catch (error) {
    state.log(`list-models failed (${state.command}): ${error instanceof Error ? error.message : String(error)}`);
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
  } catch (error) {
    state.log(`skills list failed (${state.command}): ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

// ponytail: shared Build/Plan catalog+config modes, keep identical in both places
const MODES = [
  { id: "build", label: "Build" },
  { id: "plan", label: "Plan" },
] as const;

function binaryHint(state: ConnectionState): string {
  const source =
    state.commandSource === "env"
      ? "from COMMANDCODE_CLI_COMMAND"
      : state.commandSource === "settings"
        ? "from Settings → Plugins → Command Code"
        : `by default on ${process.platform === "win32" ? "Windows (cmdc)" : "this platform (commandcode)"}`;
  return `CLI binary "${state.command}" (resolved ${source}). Check it's on PATH, or set it in Settings → Plugins → Command Code. Auth issues? Run \`${state.command} login\` or \`${state.command} status\` in a terminal.`;
}

async function checkHealth(state: ConnectionState, cwd: string): Promise<HealthState> {
  if (state.health.checked && Date.now() - state.health.checkedAt < HEALTH_TTL_MS) return state.health;
  try {
    const env: Record<string, string> = {};
    for (const [key, value] of Object.entries(process.env)) {
      if (value !== undefined) env[key] = value;
    }
    const { stdout } = await state.exec(state.command, ["--version"], { cwd, env, timeoutMs: 15_000 });
    const version = stdout.trim().split("\n")[0]?.trim();
    state.health = { checked: true, ok: true, version: version || undefined, checkedAt: Date.now() };
    state.log(`health ok: ${state.command}${version ? ` (${version})` : ""}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    state.health = { checked: true, ok: false, error: message, checkedAt: Date.now() };
    state.log(`health failed (${state.command}): ${message}`);
  }
  return state.health;
}

function friendlySpawnError(error: unknown, state: ConnectionState): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/ENOENT/i.test(message)) {
    return `Couldn't start "${state.command}" (not found). ${binaryHint(state)}`;
  }
  return `${message}. ${binaryHint(state)}`;
}

function friendlyExitError(stderr: string, code: number | null, state: ConnectionState): string {
  const detail = truncate(stderr.trim(), 500);
  if (/not logged in|auth|login|unauthor/i.test(detail)) {
    return `${detail || `commandcode exited with code ${code}`}. Run \`${state.command} login\` (or \`${state.command} status\`) in a terminal, then retry.`;
  }
  if (/unknown flag|invalid|effort/i.test(detail)) {
    return `${detail}. The selected model may not support this effort level — try a different effort or leave it unset.`;
  }
  return `${detail || `commandcode exited with code ${code ?? "unknown"}`}. ${binaryHint(state)}`;
}

export function makeTitle(configTitle: string | undefined, firstPrompt: string): string | undefined {
  if (configTitle?.trim()) return configTitle;
  const oneLine = firstPrompt.replace(/\s+/g, " ").trim();
  return oneLine ? oneLine.slice(0, 80) : undefined;
}

type PersistedData = {
  sessionId?: string;
  tasks?: Array<{ id: string; text: string; status: "pending" | "in_progress" | "completed"; activeForm?: string }>;
};

function persistenceData(session: Session): { version: 1; data: PersistedData } {
  const data: PersistedData = {};
  if (session.nativeSessionId) data.sessionId = session.nativeSessionId;
  if (session.tasks.size > 0) {
    data.tasks = [...session.tasks.entries()].map(([id, task]) => ({
      id,
      text: task.text,
      status: task.status,
      ...(task.activeForm ? { activeForm: task.activeForm } : {}),
    }));
  }
  return { version: 1, data };
}

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
    thinkingOptions: EFFORTS.map((effort) => ({
      ...effort,
      description: "Levels vary per model — leave unset if the CLI rejects your choice.",
    })),
    ...(state.defaultModel ? { defaultModel: state.defaultModel } : {}),
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
    case "sessions":
      state.emit({
        type: "sessions",
        requestId: input.requestId,
        sessions: listNativeSessions({ query: input.query, cwd: input.cwd, limit: input.limit }),
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
      if (session?.active) {
        session.active.interrupted = true;
        session.active.proc.kill();
      }
      state.emit({ type: "request.completed", requestId: input.requestId });
      return;
    }
    case "session.close": {
      const session = state.sessions.get(input.sessionId);
      if (session?.active) {
        session.active.interrupted = true;
        session.active.proc.kill();
      }
      state.sessions.delete(input.sessionId);
      state.emit({ type: "session.closed", sessionId: input.sessionId });
      state.emit({ type: "request.completed", requestId: input.requestId });
      return;
    }
    default:
      return;
  }
}

function resumeData(persistence: ProviderPersistence | undefined): PersistedData {
  const data = persistence?.data;
  if (typeof data !== "object" || data === null || Array.isArray(data)) return {};
  const record = data as Record<string, unknown>;
  const out: PersistedData = {};
  if (typeof record.sessionId === "string") out.sessionId = record.sessionId;
  if (Array.isArray(record.tasks)) {
    const tasks: NonNullable<PersistedData["tasks"]> = [];
    for (const entry of record.tasks) {
      if (typeof entry !== "object" || entry === null) continue;
      const task = entry as Record<string, unknown>;
      if (typeof task.id !== "string" || typeof task.text !== "string") continue;
      if (task.status !== "pending" && task.status !== "in_progress" && task.status !== "completed") continue;
      tasks.push({
        id: task.id,
        text: task.text,
        status: task.status,
        ...(typeof task.activeForm === "string" ? { activeForm: task.activeForm } : {}),
      });
    }
    if (tasks.length > 0) out.tasks = tasks;
  }
  return out;
}

function openSession(
  input: Extract<ProviderInput, { type: "session.open" }>,
  state: ConnectionState,
): void {
  const resumed = resumeData(input.persistence);
  const session: Session = {
    config: input.config,
    nativeSessionId: resumed.sessionId ?? null,
    transcript: [],
    active: null,
    tasks: new Map((resumed.tasks ?? []).map((task) => [task.id, { text: task.text, status: task.status, ...(task.activeForm ? { activeForm: task.activeForm } : {}) }])),
  };
  state.sessions.set(input.sessionId, session);
  state.emit({
    type: "session.opened",
    requestId: input.requestId,
    sessionId: input.sessionId,
    capabilities: ["prompt.message", "prompt.command", "session.configure", "session.list", "session.persistence"],
    restoration: "core",
    ...(session.nativeSessionId || session.tasks.size > 0 ? { persistence: persistenceData(session) } : {}),
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
  void checkHealth(state, session.config.cwd).then((health) => {
    if (health.ok || !state.sessions.has(input.sessionId)) return;
    state.emit({
      type: "session.notice",
      sessionId: input.sessionId,
      notice: {
        id: `health-${input.sessionId}`,
        severity: "error",
        title: `Couldn't reach the Command Code CLI`,
        description: `${friendlySpawnError(health.error ?? "unknown error", state)}`,
      },
    });
  });
  if (input.history === "replay") {
    if (session.nativeSessionId && session.transcript.length === 0) {
      const replayed = readNativeTranscript(session.nativeSessionId);
      session.transcript.push(...replayed.items);
      for (const task of replayed.tasks) {
        if (!session.tasks.has(task.id)) {
          session.tasks.set(task.id, { text: task.text, status: task.status });
        }
      }
    }
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
  const models = state?.models ?? [];
  const defaultModel = state?.defaultModel ?? session.config.model;
  return {
    ...(session.config.model ?? defaultModel ? { model: session.config.model ?? defaultModel } : {}),
    mode: session.config.mode ?? "build",
    thinkingOption: effort,
    models: modelsView(models),
    modes: MODES.map((mode) => ({ ...mode })),
    thinkingOptions: EFFORTS.map((option) => ({
      ...option,
      description: "Levels vary per model — leave unset if the CLI rejects your choice.",
    })),
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

function promptText(content: ProviderContent[]): { text: string; unsupported: string[] } {
  let text = "";
  const unsupported = new Set<string>();
  for (const part of content) {
    if (part.type === "text") text += (text ? "\n" : "") + part.text;
    else if (part.type === "image") {
      unsupported.add("Images are not supported by the headless CLI");
    } else if (part.type === "uploaded_file") {
      text += (text ? "\n" : "") + `[Attached file: ${part.fileName} (${part.path})]`;
      unsupported.add("File contents aren't forwarded — reference the file by path instead");
    } else {
      unsupported.add(`Attachments of type "${part.type}" are not forwarded`);
    }
  }
  return { text, unsupported: [...unsupported] };
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
  const { text, unsupported } = promptText(input.prompt.input.content);
  if (!text.trim()) {
    fail(["Empty prompt", ...unsupported].join(". "));
    return;
  }
  if (unsupported.length > 0) {
    const session = state.sessions.get(input.sessionId);
    if (session) {
      session.transcript.push({
        type: "notification",
        id: `warn-${input.prompt.clientMessageId}`,
        level: "warning",
        message: unsupported.join(". "),
      });
      state.emit({
        type: "timeline.item",
        sessionId: input.sessionId,
        item: session.transcript[session.transcript.length - 1],
      });
    }
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
  // ponytail: the Tasks pill renders timeline todo items, same as opencode's
  // provider — task_* tool calls maintain a session task list emitted here
  const emitTasks = () => {
    if (session.tasks.size === 0) return;
    push({
      type: "todo",
      id: "tasks",
      items: [...session.tasks.entries()].map(([id, task]) => ({
        id,
        text: task.text,
        completed: task.status === "completed",
        status: task.status,
        ...(task.activeForm ? { activeForm: task.activeForm } : {}),
      })),
    });
  };
  const taskStatusOf = (value: unknown): "pending" | "in_progress" | "completed" | "deleted" | undefined =>
    value === "pending" || value === "in_progress" || value === "completed" || value === "deleted"
      ? value
      : undefined;
  if (!session.titleFromPrompt && !text.startsWith("/")) {
    const title = makeTitle(session.config.title, text);
    if (title && title !== session.config.title) {
      session.titleFromPrompt = title;
      state.emit({
        type: "session.opened",
        sessionId,
        capabilities: ["prompt.message", "prompt.command", "session.configure", "session.list", "session.persistence"],
        restoration: "core",
        persistence: persistenceData(session),
        title: session.titleFromPrompt || undefined,
        cwd: session.config.cwd,
      });
    }
  }
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
    state.log(`spawn failed (${commandFor(session, state)}): ${error instanceof Error ? error.message : String(error)}`);
    state.emit({
      type: "session.turn",
      sessionId,
      turnId,
      state: "failed",
      error: { message: friendlySpawnError(error, state) },
    });
    return;
  }
  session.active = { turnId, proc, interrupted: false };

  let assistantText = "";
  let thinkingText = "";
  let usage: { inputTokens?: number; outputTokens?: number } | undefined;
  let stderr = "";
  let finished = false;
  const tools = new Map<
    string,
    { name: string; input: Record<string, unknown>; resultText?: string; status: "running" }
  >();
  let pendingAssistant = false;
  let pendingReasoning = false;
  let lastFlush = 0;
  const lastFlushLen = { assistant: 0, reasoning: 0 };
  const flushStream = () => {
    if (pendingReasoning) {
      pendingReasoning = false;
      lastFlushLen.reasoning = thinkingText.length;
      push({ type: "reasoning", id: `reasoning-${turnId}`, text: thinkingText });
    }
    if (pendingAssistant) {
      pendingAssistant = false;
      lastFlushLen.assistant = assistantText.length;
      push({ type: "assistant_message", id: `assistant-${turnId}`, text: assistantText });
    }
    lastFlush = Date.now();
  };
  const scheduleFlush = () => {
    if (Date.now() - lastFlush >= STREAM_FLUSH_MS) flushStream();
  };
  const finish = (terminal: "completed" | "failed" | "canceled", error?: string) => {
    if (finished) return;
    finished = true;
    flushStream();
    session.active = null;
    state.emit({
      type: "session.persistence",
      sessionId,
      persistence: persistenceData(session),
    });
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
            persistence: persistenceData(session),
          });
          break;
        case "thinking_delta":
          thinkingText += parsed.delta;
          pendingReasoning = true;
          if (thinkingText.length - lastFlushLen.reasoning >= STREAM_FLUSH_CHARS) flushStream();
          else scheduleFlush();
          break;
        case "thinking_end":
          thinkingText = parsed.text;
          pendingReasoning = true;
          flushStream();
          break;
        case "text_delta":
          assistantText += parsed.delta;
          pendingAssistant = true;
          if (assistantText.length - lastFlushLen.assistant >= STREAM_FLUSH_CHARS) flushStream();
          else scheduleFlush();
          break;
        case "message_update":
          if (parsed.thinking && parsed.thinking !== thinkingText) {
            thinkingText = parsed.thinking;
            pendingReasoning = true;
            flushStream();
          }
          if (parsed.text && parsed.text !== assistantText) {
            assistantText = parsed.text;
            pendingAssistant = true;
            flushStream();
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
          // ponytail: optimistic pill update so status flips show immediately
          if (parsed.kind === "tool_queued" && parsed.toolName === "task_update") {
            const id = String(parsed.input.taskId ?? "");
            const task = id ? session.tasks.get(id) : undefined;
            const status = taskStatusOf(parsed.input.status);
            const subject = typeof parsed.input.subject === "string" ? parsed.input.subject : undefined;
            if (id && (task || subject)) {
              if (status === "deleted") session.tasks.delete(id);
              else {
                session.tasks.set(id, {
                  text: subject ?? task?.text ?? id,
                  status: status ?? task?.status ?? "pending",
                  activeForm:
                    typeof parsed.input.activeForm === "string"
                      ? parsed.input.activeForm
                      : task?.activeForm,
                });
              }
              emitTasks();
            }
          }
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
          if (existing.name === "task_list") {
            const items = parseTaskList(parsed.resultText);
            if (items.length > 0) {
              session.tasks = new Map(
                items.map((item) => [item.id, { text: item.text, status: item.status }]),
              );
              emitTasks();
            }
          } else if (existing.name === "task_get") {
            const item = parseTaskGet(parsed.resultText);
            if (item) {
              const prev = session.tasks.get(item.id);
              session.tasks.set(item.id, { text: item.text, status: item.status, activeForm: prev?.activeForm });
              emitTasks();
            }
          } else if (existing.name === "task_create" || existing.name === "task_update") {
            const input = existing.input as Record<string, unknown>;
            const id = String(input.taskId ?? parseTaskId(parsed.resultText) ?? "");
            const status = taskStatusOf(input.status);
            const subject = (input.subject ?? input.description) as unknown;
            const title =
              typeof subject === "string" && subject
                ? subject
                : /^Task #\S+ created:\s*(.+?)\s*$/.exec(parsed.resultText)?.[1];
            if (existing.name === "task_create" && id) {
              session.tasks.set(id, {
                text: title || `Task ${id}`,
                status: status && status !== "deleted" ? status : "pending",
                ...(typeof input.activeForm === "string" ? { activeForm: input.activeForm } : {}),
              });
              emitTasks();
            } else if (existing.name === "task_update" && id) {
              if (status === "deleted") {
                if (session.tasks.delete(id)) emitTasks();
              } else {
                const prev = session.tasks.get(id);
                if (prev || title || status) {
                  session.tasks.set(id, {
                    text: title ?? prev?.text ?? `Task ${id}`,
                    status: status ?? prev?.status ?? "pending",
                    activeForm:
                      typeof input.activeForm === "string" ? input.activeForm : prev?.activeForm,
                  });
                  emitTasks();
                }
              }
            }
          }
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
              persistence: persistenceData(session),
            });
          }
          if (!assistantText && parsed.finalText) {
            assistantText = parsed.finalText;
            pendingAssistant = true;
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
  proc.on("error", (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    state.log(`turn ${turnId} proc error: ${message}`);
    const interrupted = session.active?.interrupted;
    push({ type: "error", id: `error-${turnId}`, message: friendlySpawnError(message, state) });
    finish(interrupted ? "canceled" : "failed", friendlySpawnError(message, state));
  });
  proc.on("close", (code) => {
    if (finished) return;
    const interrupted = session.active?.interrupted;
    if (interrupted) {
      if (buffer.trim()) onChunk("\n");
      finish("canceled");
      return;
    }
    if (buffer.trim()) onChunk("\n");
    if (typeof code === "number" && code !== 0) {
      const message = friendlyExitError(stderr, code, state);
      state.log(`turn ${turnId} exited ${code}: ${truncate(stderr.trim(), 200) || "no stderr"}`);
      finish("failed", message);
    } else if (code === null || code === undefined) {
      finish("canceled");
    } else {
      finish(assistantText ? "completed" : "failed", assistantText ? undefined : `No response from the CLI. ${binaryHint(state)}`);
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
      if (def.showOutput || def.notifyOnSuccess) {
        state.emit({
          type: "session.notice",
          sessionId,
          notice: {
            id: `cmd-${clientMessageId}`,
            severity: "info",
            title: `/${name}`,
            description: truncate(output || def.successMessage || "(no output)", 4000),
          },
        });
      }
      done({ type: "completed" });
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      state.log(`/${name} failed: ${message}`);
      done({
        type: "failed",
        error: { message: `/${name} failed: ${friendlySpawnError(message, state)}` },
      });
    });
}

function truncate(text: string, max = 8000): string {
  return text.length > max ? `${text.slice(0, max)}\n…(truncated)` : text;
}
