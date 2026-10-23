import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { runAcpProvider, type AcpTransformer } from "@getpaseo/plugin/server/acp";
import type {
  ProviderCommand,
  ProviderConnection,
  ProviderEvent,
  ProviderInput,
  ProviderRegistration,
} from "@getpaseo/plugin/server/provider";
import { commandArgv, COMMANDS, findCommand } from "./commands.js";
import { readSettingsDocument } from "./settings.js";
import { CLI_DEFAULTS, cliSettings } from "../shared/settings.js";

const execFileAsync = promisify(execFile);

export type ExecFn = (
  command: string,
  args: string[],
  options: { cwd: string; env: Record<string, string> },
) => Promise<{ stdout: string; stderr: string }>;

type CommandSource = "env" | "settings" | "default";

const defaultExec: ExecFn = (command, args, options) =>
  execFileAsync(command, args, {
    cwd: options.cwd,
    env: { ...process.env, ...options.env },
    timeout: 120_000,
    maxBuffer: 1024 * 1024,
  }).then(
    ({ stdout, stderr }) => ({ stdout: String(stdout), stderr: String(stderr) }),
    (error: { stdout?: unknown; stderr?: unknown; message?: string }) => {
      // surface CLI stdout/stderr on failure instead of a bare exit code
      const detail = [error.stdout, error.stderr]
        .map((part) => (typeof part === "string" ? part.trim() : ""))
        .filter(Boolean)
        .join("\n");
      throw new Error(detail || error.message || String(error));
    },
  );

export function resolveCommand(override?: string): { command: string; source: CommandSource } {
  const envOverride = override?.trim() || process.env.COMMANDCODE_CLI_COMMAND?.trim();
  if (envOverride) return { command: envOverride, source: "env" };
  const configured = readSettingsDocument(cliSettings, CLI_DEFAULTS).command.trim();
  if (configured) return { command: configured, source: "settings" };
  return { command: process.platform === "win32" ? "cmdc" : "commandcode", source: "default" };
}

function binaryHint(command: string, source: CommandSource): string {
  const from =
    source === "env"
      ? "from COMMANDCODE_CLI_COMMAND"
      : source === "settings"
        ? "from Settings → Plugins → Command Code"
        : `by default on ${process.platform === "win32" ? "Windows (cmdc)" : "this platform (commandcode)"}`;
  return `CLI binary "${command}" (resolved ${from}). Check it's on PATH and new enough to support \`${command} acp\`, or set it in Settings → Plugins → Command Code. Auth issues? Run \`${command} login\` in a terminal.`;
}

/**
 * Agents created before the ACP switch persisted a "build" mode and a "yolo"
 * setting. The CLI rejects both, and an unknown value would fail the whole
 * session open, so drop them: such agents land in the CLI's default mode
 * (Standard, which asks before changes). Stale effort/model values get the
 * same treatment.
 */
export const legacyConfig: AcpTransformer = {
  async configure(change, { config }) {
    if (change.target === "mode") return change.value === "build" ? "handled" : "pass";
    if (change.target === "setting") return change.id in (await config.read()) ? "pass" : "handled";
    if (change.value === null) return "pass";
    const id = change.target === "thinking" ? "effort" : "model";
    // the print-mode provider offered "max"; the CLI's top level is "xhigh"
    const value = change.target === "thinking" && change.value === "max" ? "xhigh" : change.value;
    try {
      await config.set(id, value);
    } catch (error) {
      console.error(`[commandcode-provider] ignoring ${id}=${String(value)}: ${error instanceof Error ? error.message : error}`);
    }
    return "handled";
  },
};

/** The SDK's edit detail reads camelCase keys; Command Code tools use snake_case. */
export const editInput: AcpTransformer = {
  toolCall(snapshot) {
    const input = snapshot.input;
    if (snapshot.kind !== "edit" || typeof input !== "object" || input === null || Array.isArray(input)) return snapshot;
    const mapped = { ...input };
    const alias = (to: string, ...from: string[]) => {
      const value = [to, ...from].map((key) => input[key]).find((candidate) => typeof candidate === "string");
      if (value !== undefined) mapped[to] = value;
    };
    alias("filePath", "file_path", "path");
    alias("oldString", "old_string");
    alias("newString", "new_string", "content");
    return { ...snapshot, input: mapped };
  },
};

export function createCommandcodeProvider(options?: { command?: string; exec?: ExecFn }): ProviderRegistration {
  return {
    id: "commandcode",
    label: "Command Code",
    description: "Command Code coding agent (over ACP via `commandcode acp`)",
    icon: "icon.svg",
    async connect(request) {
      const { command, source } = resolveCommand(options?.command);
      const acp = runAcpProvider({
        id: "commandcode",
        label: "Command Code",
        command: [command, "acp"],
        transformers: [legacyConfig, editInput],
        acpOptions: { waitForInitialCommands: true },
      });
      let inner: ProviderConnection;
      try {
        // The host only fills request.launch for registrations that declare a
        // `command`; this one doesn't, so the binary resolved above is spawned.
        inner = await acp.connect(request);
      } catch (error) {
        throw new Error(`${error instanceof Error ? error.message : String(error)}. ${binaryHint(command, source)}`);
      }
      return withCliCommands(inner, command, options?.exec ?? defaultExec);
    },
  };
}

/**
 * Adds the provider-side slash commands (headless `commandcode` subcommands
 * like /status) on top of the commands the CLI advertises over ACP.
 */
export function withCliCommands(inner: ProviderConnection, command: string, exec: ExecFn): ProviderConnection {
  const sessions = new Map<string, { cwd: string; env: Record<string, string> }>();
  const busy = new Set<string>();
  const listeners = new Set<(event: ProviderEvent) => void>();
  const emit = (event: ProviderEvent) => {
    for (const listener of listeners) listener(event);
  };
  const unsubscribe = inner.onEvent((event) => {
    if (event.type === "session.turn") {
      if (event.state === "started") busy.add(event.sessionId);
      else busy.delete(event.sessionId);
    }
    emit(event.type === "session.commands" ? { ...event, commands: mergeCommands(event.commands) } : event);
  });

  const runCommand = (input: Extract<ProviderInput, { type: "session.prompt" }>, name: string, args: string) => {
    const { sessionId } = input;
    const { clientMessageId } = input.prompt;
    const done = (error?: string) =>
      emit({
        type: "session.prompt_result",
        sessionId,
        clientMessageId,
        result: error ? { type: "failed", error: { message: error } } : { type: "completed" },
      });
    const def = findCommand(name)!;
    if (busy.has(sessionId) && !def.allowWhileRunning) return done(`/${name} needs the active turn to finish first`);
    const argv = commandArgv(def, args);
    if (!Array.isArray(argv)) return done(argv.error);
    const session = sessions.get(sessionId);
    void exec(command, argv, { cwd: session?.cwd ?? process.cwd(), env: session?.env ?? {} }).then(
      ({ stdout, stderr }) => {
        if (def.showOutput || def.notifyOnSuccess) {
          const output = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n");
          emit({
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
        done();
      },
      (error: unknown) => done(`/${name} failed: ${error instanceof Error ? error.message : String(error)}`),
    );
  };

  return {
    version: inner.version,
    capabilities: inner.capabilities,
    async send(input) {
      if (input.type === "session.open") sessions.set(input.sessionId, { cwd: input.config.cwd, env: input.config.env });
      if (input.type === "session.close") {
        sessions.delete(input.sessionId);
        busy.delete(input.sessionId);
      }
      if (input.type === "session.prompt" && input.prompt.input.type === "command" && findCommand(input.prompt.input.name)) {
        runCommand(input, input.prompt.input.name, input.prompt.input.arguments);
        return;
      }
      return inner.send(input);
    },
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async close() {
      unsubscribe();
      listeners.clear();
      await inner.close();
    },
  };
}

function mergeCommands(native: readonly ProviderCommand[]): ProviderCommand[] {
  const names = new Set(native.map((command) => command.name));
  const extra = COMMANDS.filter((command) => !names.has(command.name)).map((command) => ({
    name: command.name,
    description: command.description,
    ...(command.argumentHint ? { argumentHint: command.argumentHint } : {}),
  }));
  return [...native, ...extra];
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n…(truncated)` : text;
}
