import { describe, expect, it } from "vitest";
import type { AcpConfigAccess } from "@getpaseo/plugin/server/acp";
import type { ProviderConnection, ProviderEvent, ProviderInput } from "@getpaseo/plugin/server/provider";
import { editInput, legacyConfig, withCliCommands, type ExecFn } from "../server/provider.js";

function fakeConfig(values: Record<string, string>, reject = new Set<string>()) {
  const sets: Array<[string, unknown]> = [];
  const config: AcpConfigAccess = {
    read: async () => values,
    set: async (id, value) => {
      if (reject.has(String(value))) throw new Error(`bad ${id}`);
      sets.push([id, value]);
    },
  };
  return { config, sets };
}

describe("legacyConfig", () => {
  const ctx = (config: AcpConfigAccess) => ({ sessionId: "s", config });

  it("drops the print-mode build mode and yolo setting, keeps real ones", async () => {
    const { config } = fakeConfig({ model: "m", effort: "low" });
    expect(await legacyConfig.configure!({ target: "mode", value: "build" }, ctx(config))).toBe("handled");
    expect(await legacyConfig.configure!({ target: "mode", value: "plan" }, ctx(config))).toBe("pass");
    expect(await legacyConfig.configure!({ target: "setting", id: "yolo", value: "on" }, ctx(config))).toBe("handled");
    expect(await legacyConfig.configure!({ target: "setting", id: "effort", value: "high" }, ctx(config))).toBe("pass");
  });

  it("maps max effort to xhigh and swallows stale values the CLI rejects", async () => {
    const { config, sets } = fakeConfig({}, new Set(["gone-model"]));
    expect(await legacyConfig.configure!({ target: "thinking", value: "max" }, ctx(config))).toBe("handled");
    expect(await legacyConfig.configure!({ target: "model", value: "gone-model" }, ctx(config))).toBe("handled");
    expect(sets).toEqual([["effort", "xhigh"]]);
  });
});

describe("editInput", () => {
  it("adds camelCase edit keys from snake_case tool input", () => {
    const snapshot = {
      id: "t",
      kind: "edit",
      title: "Edit",
      status: "pending" as const,
      input: { file_path: "/a.ts", old_string: "x", new_string: "y" },
      output: null,
      locations: [],
    };
    expect(editInput.toolCall!(snapshot, { sessionId: "s" }).input).toMatchObject({
      filePath: "/a.ts",
      oldString: "x",
      newString: "y",
    });
  });
});

function fakeInner() {
  const sent: ProviderInput[] = [];
  let listener: (event: ProviderEvent) => void = () => {};
  const inner: ProviderConnection = {
    version: 1,
    capabilities: ["prompt.message", "prompt.command"],
    send: async (input) => void sent.push(input),
    onEvent: (fn) => ((listener = fn), () => {}),
    close: async () => {},
  };
  return { inner, sent, fire: (event: ProviderEvent) => listener(event) };
}

const command = (name: string, args = ""): ProviderInput =>
  ({
    type: "session.prompt",
    sessionId: "s",
    prompt: { clientMessageId: "c1", input: { type: "command", name, arguments: args } },
  }) as ProviderInput;

describe("withCliCommands", () => {
  it("merges provider commands into the CLI's list without duplicates", () => {
    const { inner, fire } = fakeInner();
    const events: ProviderEvent[] = [];
    withCliCommands(inner, "cmd", async () => ({ stdout: "", stderr: "" })).onEvent((e) => events.push(e));
    fire({ type: "session.commands", sessionId: "s", commands: [{ name: "compact", description: "c" }, { name: "status", description: "native" }] });
    const names = (events[0] as Extract<ProviderEvent, { type: "session.commands" }>).commands.map((c) => c.name);
    expect(names.filter((n) => n === "status")).toHaveLength(1);
    expect(names).toContain("compact");
    expect(names).toContain("mcp-list");
  });

  it("runs provider commands via the CLI and forwards everything else", async () => {
    const { inner, sent } = fakeInner();
    const calls: string[][] = [];
    const exec: ExecFn = async (_cmd, args) => (calls.push(args), { stdout: "logged in", stderr: "" });
    const conn = withCliCommands(inner, "cmd", exec);
    const events: ProviderEvent[] = [];
    conn.onEvent((e) => events.push(e));
    await conn.send(command("status"));
    await conn.send(command("compact"));
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toEqual([["status"]]);
    expect(sent.map((i) => i.type === "session.prompt" && i.prompt.input.type === "command" && i.prompt.input.name)).toEqual(["compact"]);
    expect(events.find((e) => e.type === "session.notice")).toMatchObject({ notice: { description: "logged in" } });
    expect(events.find((e) => e.type === "session.prompt_result")).toMatchObject({ result: { type: "completed" } });
  });

  it("blocks mutating commands while a turn runs", async () => {
    const { inner, fire } = fakeInner();
    const conn = withCliCommands(inner, "cmd", async () => ({ stdout: "", stderr: "" }));
    const events: ProviderEvent[] = [];
    conn.onEvent((e) => events.push(e));
    fire({ type: "session.turn", sessionId: "s", turnId: "t", state: "started" });
    await conn.send(command("skills-add", "a/b"));
    expect(events.at(-1)).toMatchObject({ type: "session.prompt_result", result: { type: "failed" } });
  });
});
