import { describe, expect, it } from "vitest";
import { buildArgs, parseLine } from "./commandcode.js";
import { createCommandcodeProvider, type Proc, type SpawnFn } from "./provider.js";
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
});
