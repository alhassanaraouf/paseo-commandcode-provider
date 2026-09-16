import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildArgs, parseLine, parseTaskGet, parseTaskId, parseTaskList } from "./commandcode.js";
import { createCommandcodeProvider, type Proc, type SpawnFn } from "./provider.js";
import { listNativeSessions, readNativeTranscript } from "./sessions.js";
import { parseSkillsList } from "./skills.js";
import type { ProviderEvent } from "@getpaseo/plugin/server/provider";

function stream() {
  const listeners = new Map<string, Array<(...args: unknown[]) => void>>();
  return {
    on(event: string, listener: (...args: unknown[]) => void) {
      const list = listeners.get(event) ?? [];
      list.push(listener);
      listeners.set(event, list);
    },
    emit(event: string, ...args: unknown[]) {
      for (const listener of listeners.get(event) ?? []) listener(...args);
    },
  };
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

describe("commandcode provider", () => {
  it("parses NDJSON lines and builds headless args", () => {
    expect(parseLine('{"type":"event","event":{"type":"text_delta","delta":"hi"}}').kind).toBe("text_delta");
    expect(parseLine("not json").kind).toBe("ignored");
    expect(buildArgs({ model: "m", effort: "high", resumeSessionId: "s1" }, "hello")).toEqual([
      "-p",
      "--output-format",
      "json",
      "--trust",
      "--model",
      "m",
      "--effort",
      "high",
      "--session",
      "s1",
      "hello",
    ]);
    // ponytail: effort omitted unless chosen — valid levels are per-model
    expect(buildArgs({}, "hello")).not.toContain("--effort");
    // ponytail: yolo unlocks withheld headless tools (--auto-accept doesn't)
    expect(buildArgs({ yolo: true }, "hello")).toEqual(
      expect.arrayContaining(["--yolo", "--tools-all"]),
    );
    expect(buildArgs({}, "hello")).not.toContain("--yolo");
  });

  it("runs a provider command as a CLI side effect", async () => {
    const connection = await createCommandcodeProvider({
      spawn: () => {
        throw new Error("no spawn in command test");
      },
      exec: (cmd, args) => {
        expect(cmd).toBe("commandcode");
        expect(args).toEqual(["taste", "list"]);
        return Promise.resolve({ stdout: "no packages", stderr: "" });
      },
      listModels: () => Promise.resolve("fallback-model  fallback (default)"),
      listSkills: () => Promise.resolve(""),
    }).connect({
      versions: [1],
      capabilities: ["prompt.message", "prompt.command", "session.configure", "session.persistence"],
    });
    const events: ProviderEvent[] = [];
    connection.onEvent((event) => events.push(event));
    await connection.send({
      type: "session.open",
      requestId: "o1",
      sessionId: "s1",
      config: { cwd: "/tmp", env: {}, mcpServers: {}, settings: {}, persist: false },
      history: "skip",
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const commands = events.find(
      (event): event is Extract<ProviderEvent, { type: "session.commands" }> => event.type === "session.commands",
    );
    expect(commands?.commands.map((command) => command.name)).toContain("taste-learn");
    await connection.send({
      type: "session.prompt",
      sessionId: "s1",
      prompt: {
        clientMessageId: "c1",
        delivery: "auto",
        input: { type: "command", name: "taste-list", arguments: "" },
      },
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "session.prompt_result",
        clientMessageId: "c1",
        result: { type: "completed" },
      }),
    );
    expect(events).toContainEqual(expect.objectContaining({ type: "session.notice" }));
    await connection.close();
  });

  it("parses `skills list` output", () => {
    const output = [
      "",
      " Skills  9 installed",
      "",
      "Global (9)",
      "  better-ui · Polishes and improves the UI in your project. Covers conc...",
      "  paseo · Paseo reference for managing projects, workspaces, worksp...",
      "",
      "Bundled (6)",
      "  config · Inspect or change validated Command Code settings. Use wh...",
    ].join("\n");
    expect(parseSkillsList(output)).toEqual([
      { name: "better-ui", description: "Polishes and improves the UI in your project. Covers conc..." },
      { name: "paseo", description: "Paseo reference for managing projects, workspaces, worksp..." },
      { name: "config", description: "Inspect or change validated Command Code settings. Use wh..." },
    ]);
    expect(parseSkillsList("")).toEqual([]);
  });

  it("lists live models from the CLI", async () => {
    const fakeModels = [
      "some-model-1  first model (default)",
      "other/model-2  second model",
      "Anthropic",
      "",
    ].join("\n");
    const connection = await createCommandcodeProvider({
      spawn: () => {
        throw new Error("no spawn in catalog test");
      },
      listModels: () => Promise.resolve(fakeModels),
    }).connect({ versions: [1], capabilities: ["prompt.message"] });
    const events: ProviderEvent[] = [];
    connection.onEvent((event) => events.push(event));
    await connection.send({ type: "catalog", requestId: "c1" });
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
    const catalog = events.find(
      (event): event is Extract<ProviderEvent, { type: "catalog" }> => event.type === "catalog",
    );
    expect(catalog?.catalog.models.map((model) => model.id)).toEqual(["some-model-1", "other/model-2"]);
    expect(catalog?.catalog.defaultModel).toBe("some-model-1");
    await connection.close();
  });

  it("shows an empty model list when the CLI refresh fails", async () => {
    const connection = await createCommandcodeProvider({
      spawn: () => {
        throw new Error("no spawn in catalog test");
      },
      listModels: () => Promise.reject(new Error("cli exploded")),
    }).connect({ versions: [1], capabilities: ["prompt.message"] });
    const events: ProviderEvent[] = [];
    connection.onEvent((event) => events.push(event));
    await connection.send({ type: "catalog", requestId: "c1" });
    await tick();
    await tick();
    const catalog = events.find(
      (event): event is Extract<ProviderEvent, { type: "catalog" }> => event.type === "catalog",
    );
    expect(catalog?.catalog.models).toEqual([]);
    expect(catalog?.catalog.defaultModel).toBeUndefined();
    await connection.close();
  });

  it("runs a prompt lifecycle against a fake commandcode", async () => {
    let spawnedArgs: string[] = [];
    const stdout = stream();
    const stderr = stream();
    const procEvents = stream();
    const fakeSpawn: SpawnFn = (_cmd, args) => {
      spawnedArgs = args;
      return {
        stdout: stdout as unknown as Proc["stdout"],
        stderr: stderr as unknown as Proc["stderr"],
        on: procEvents.on,
        kill: () => {},
      } as Proc;
    };
    const connection = await createCommandcodeProvider({
      spawn: fakeSpawn,
      listModels: () => Promise.resolve("fallback-model  fallback (default)"),
    }).connect({
      versions: [1],
      capabilities: ["prompt.message", "session.configure", "session.persistence"],
    });
    const events: ProviderEvent[] = [];
    connection.onEvent((event) => events.push(event));

    await connection.send({ type: "catalog", requestId: "c1" });
    await connection.send({
      type: "session.open",
      requestId: "o1",
      sessionId: "s1",
      config: { cwd: "/tmp", env: {}, mcpServers: {}, settings: {}, persist: true },
      history: "skip",
    });
    await tick();
    await connection.send({
      type: "session.prompt",
      sessionId: "s1",
      prompt: {
        clientMessageId: "m1",
        delivery: "auto",
        input: { type: "message", content: [{ type: "text", text: "hello" }] },
      },
    });
    await tick();
    expect(spawnedArgs).toContain("hello");

    stdout.emit(
      "data",
      '{"type":"event","event":{"type":"run_start","sessionId":"native-1"}}\n' +
        '{"type":"event","event":{"type":"text_delta","delta":"hi there"}}\n' +
        '{"type":"result","subtype":"success","sessionId":"native-1","finalText":"hi there"}\n',
    );
    procEvents.emit("close", 0);
    await tick();
    await tick();

    const types: string[] = events.map((event) => event.type);
    for (const expected of [
      "catalog",
      "session.opened",
      "session.config",
      "session.ready",
      "session.prompt_result",
      "session.turn",
      "timeline.item",
      "session.persistence",
    ]) {
      expect(types).toContain(expected);
    }
    const user = events.find(
      (event): event is Extract<ProviderEvent, { type: "timeline.item" }> =>
        event.type === "timeline.item" && event.item.type === "user_message",
    );
    expect(user?.item.type === "user_message" ? user.item.clientMessageId : undefined).toBe("m1");
    const turnDone = events.find(
      (event): event is Extract<ProviderEvent, { type: "session.turn" }> =>
        event.type === "session.turn" && event.state === "completed",
    );
    expect(turnDone).toBeDefined();
    await connection.close();
  });

  it("parses task payloads for the Tasks pill", () => {
    expect(parseTaskList("#1 [pending] Write docs\n#2 [in_progress] Fix bug\n\n0/2 completed")).toEqual([
      { id: "1", text: "Write docs", status: "pending" },
      { id: "2", text: "Fix bug", status: "in_progress" },
    ]);
    expect(parseTaskGet("Task #1: Write docs\nStatus: in_progress\nDescription: docs")).toEqual({
      id: "1",
      text: "Write docs",
      status: "in_progress",
    });
    expect(parseTaskId("Task #3 created: Write tests")).toBe("3");
    expect(parseTaskId("Updated task #1: status")).toBe("1");
  });

  it("emits todo timeline items for task_* tool calls", async () => {
    const stdout = stream();
    const stderr = stream();
    const procEvents = stream();
    const fakeSpawn: SpawnFn = () => {
      return {
        stdout: stdout as unknown as Proc["stdout"],
        stderr: stderr as unknown as Proc["stderr"],
        on: procEvents.on,
        kill: () => {},
      } as Proc;
    };
    const connection = await createCommandcodeProvider({
      spawn: fakeSpawn,
      listModels: () => Promise.resolve("fallback-model  fallback (default)"),
    }).connect({
      versions: [1],
      capabilities: ["prompt.message", "session.configure", "session.persistence"],
    });
    const events: ProviderEvent[] = [];
    connection.onEvent((event) => events.push(event));
    await connection.send({
      type: "session.open",
      requestId: "o1",
      sessionId: "s1",
      config: { cwd: "/tmp", env: {}, mcpServers: {}, settings: {}, persist: false },
      history: "skip",
    });
    await tick();
    await connection.send({
      type: "session.prompt",
      sessionId: "s1",
      prompt: {
        clientMessageId: "m1",
        delivery: "auto",
        input: { type: "message", content: [{ type: "text", text: "hello" }] },
      },
    });
    await tick();
    stdout.emit(
      "data",
      '{"type":"event","event":{"type":"run_start","sessionId":"native-1"}}\n' +
        '{"type":"event","event":{"type":"tool_queued","toolCallId":"c1","toolName":"task_create","input":{"subject":"Write docs"}}}\n' +
        '{"type":"event","event":{"type":"tool_completed","toolCallId":"c1","toolName":"task_create","result":[{"type":"text","text":"Task #1 created: Write docs"}]}}\n' +
        '{"type":"event","event":{"type":"tool_queued","toolCallId":"c2","toolName":"task_update","input":{"taskId":"1","status":"in_progress"}}}\n' +
        '{"type":"event","event":{"type":"tool_completed","toolCallId":"c2","toolName":"task_update","result":[{"type":"text","text":"Updated task #1: status\\nStatus: pending -> in_progress"}]}}\n' +
        '{"type":"event","event":{"type":"tool_queued","toolCallId":"c3","toolName":"task_list","input":{}}}\n' +
        '{"type":"event","event":{"type":"tool_completed","toolCallId":"c3","toolName":"task_list","result":[{"type":"text","text":"#1 [in_progress] Write docs\\n#2 [pending] Fix bug\\n\\n0/2 completed"}]}}\n',
    );
    await tick();
    const todos = events.filter(
      (event): event is Extract<ProviderEvent, { type: "timeline.item" }> =>
        event.type === "timeline.item" && event.item.type === "todo",
    );
    expect(todos.length).toBeGreaterThan(0);
    const latest = todos.at(-1);
    expect(latest?.item.type === "todo" ? latest.item.items : undefined).toEqual([
      { id: "1", text: "Write docs", completed: false, status: "in_progress" },
      { id: "2", text: "Fix bug", completed: false, status: "pending" },
    ]);
    await connection.close();
  });

  it("advertises installed skills as slash commands and runs them as turns", async () => {
    let spawnedArgs: string[] = [];
    const stdout = stream();
    const stderr = stream();
    const procEvents = stream();
    const fakeSpawn: SpawnFn = (_cmd, args) => {
      spawnedArgs = args;
      return {
        stdout: stdout as unknown as Proc["stdout"],
        stderr: stderr as unknown as Proc["stderr"],
        on: procEvents.on,
        kill: () => {},
      } as Proc;
    };
    const connection = await createCommandcodeProvider({
      spawn: fakeSpawn,
      listModels: () => Promise.resolve("fallback-model  fallback (default)"),
      listSkills: () =>
        Promise.resolve(["Global (2)", "  paseo · Paseo reference", "  better-ui · Polish UI"].join("\n")),
    }).connect({
      versions: [1],
      capabilities: ["prompt.message", "prompt.command", "session.configure", "session.persistence"],
    });
    const events: ProviderEvent[] = [];
    connection.onEvent((event) => events.push(event));
    await connection.send({
      type: "session.open",
      requestId: "o1",
      sessionId: "s1",
      config: { cwd: "/tmp", env: {}, mcpServers: {}, settings: {}, persist: false },
      history: "skip",
    });
    await tick();
    await tick();
    const commands = events.filter(
      (event): event is Extract<ProviderEvent, { type: "session.commands" }> => event.type === "session.commands",
    );
    const latest = commands.at(-1);
    expect(latest?.commands.map((command) => command.name)).toEqual(
      expect.arrayContaining(["status", "paseo", "better-ui"]),
    );
    await connection.send({
      type: "session.prompt",
      sessionId: "s1",
      prompt: {
        clientMessageId: "c1",
        delivery: "auto",
        input: { type: "command", name: "paseo", arguments: "list projects" },
      },
    });
    await tick();
    expect(spawnedArgs.at(-1)).toBe("/paseo list projects");
    await connection.close();
  });

  it("lists native sessions and replays transcripts for import", async () => {
    const home = mkdtempSync(join(tmpdir(), "cmdc-home-"));
    const prevHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const dir = join(home, ".commandcode", "projects", "proj");
      mkdirSync(dir, { recursive: true });
      const sessionId = "11111111-2222-4333-8444-555555555555";
      writeFileSync(
        join(dir, `${sessionId}.jsonl`),
        [
          JSON.stringify({ type: "session", id: sessionId, cwd: "/tmp/proj" }),
          JSON.stringify({
            type: "message",
            id: "m1",
            message: { role: "user", content: [{ type: "text", text: "fix login" }] },
          }),
          JSON.stringify({
            type: "message",
            id: "m2",
            message: {
              role: "assistant",
              content: [
                { type: "thinking", thinking: "checking auth" },
                { type: "text", text: "fixed" },
                { type: "tool_use", id: "call_1", name: "read_file", input: { path: "a.ts" } },
              ],
            },
          }),
          JSON.stringify({
            type: "message",
            id: "m3",
            message: {
              role: "user",
              content: [{ type: "tool_result", tool_use_id: "call_1", content: [{ type: "text", text: "file contents" }] }],
            },
          }),
        ].join("\n"),
      );
      expect(listNativeSessions({})).toHaveLength(1);
      expect(listNativeSessions({ query: "nope" })).toHaveLength(0);
      const transcript = readNativeTranscript(sessionId);
      expect(transcript.map((item) => item.type)).toEqual([
        "user_message",
        "reasoning",
        "assistant_message",
        "tool_call",
      ]);

      const connection = await createCommandcodeProvider({
        spawn: () => {
          throw new Error("no spawn in import test");
        },
        listModels: () => Promise.resolve(""),
        listSkills: () => Promise.resolve(""),
      }).connect({
        versions: [1],
        capabilities: ["prompt.message", "session.configure", "session.list", "session.persistence"],
      });
      const events: ProviderEvent[] = [];
      connection.onEvent((event) => events.push(event));
      await connection.send({ type: "sessions", requestId: "l1" });
      await tick();
      await tick();
      const listed = events.find(
        (event): event is Extract<ProviderEvent, { type: "sessions" }> => event.type === "sessions",
      );
      expect(listed?.sessions).toHaveLength(1);
      expect(listed?.sessions[0].cwd).toBe("/tmp/proj");

      await connection.send({
        type: "session.open",
        requestId: "o1",
        sessionId: "s1",
        config: { cwd: "/tmp", env: {}, mcpServers: {}, settings: {}, persist: true },
        persistence: { version: 1, data: { sessionId } },
        history: "replay",
      });
      await tick();
      await tick();
      const replayed = events.filter(
        (event): event is Extract<ProviderEvent, { type: "timeline.item" }> => event.type === "timeline.item",
      );
      expect(replayed.length).toBeGreaterThanOrEqual(4);
      await connection.close();
    } finally {
      process.env.HOME = prevHome;
    }
  });
});
