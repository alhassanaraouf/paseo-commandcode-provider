import { describe, expect, it } from "vitest";
import type { ProviderConnection, ProviderInput } from "@getpaseo/plugin/server/provider";
import { translateModeId, translateModeInputs } from "../server/modes.js";
import { withLegacyModeTranslation } from "../server/acp-provider.js";

function openWithMode(mode: string | undefined): ProviderInput {
  return {
    type: "session.open",
    requestId: "o1",
    sessionId: "s1",
    config: { cwd: "/tmp", env: {}, mcpServers: {}, settings: {}, persist: false, mode },
    history: "skip",
  };
}

function configureMode(mode: string | null): ProviderInput {
  return { type: "session.configure", requestId: "r1", sessionId: "s1", changes: { mode } };
}

describe("legacy mode translation", () => {
  it("maps the -p mode ids onto ACP ones", () => {
    // `-p` shipped build/plan; ACP has default/auto-accept/plan/dont-ask/bypass.
    // An agent stored with `build` fails on its next prompt with
    // "Unknown mode: build" unless this mapping is applied.
    expect(translateModeId("build")).toBe("default");
    expect(translateModeId("accept_edits")).toBe("auto-accept");
    expect(translateModeId("accept-edits")).toBe("auto-accept");
    expect(translateModeId("yolo")).toBe("bypass");
  });

  it("leaves plan alone, since ACP kept that id", () => {
    expect(translateModeId("plan")).toBe("plan");
  });

  it("passes unknown ids through so the CLI can reject them loudly", () => {
    expect(translateModeId("something-new")).toBe("something-new");
  });

  it("rewrites the mode on session.open", () => {
    const translated = translateModeInputs(openWithMode("build"));
    expect(translated.type === "session.open" && translated.config.mode).toBe("default");
  });

  it("rewrites the mode on session.configure", () => {
    const translated = translateModeInputs(configureMode("build"));
    expect(translated.type === "session.configure" && translated.changes.mode).toBe("default");
  });

  it("keeps an explicit null as a mode reset", () => {
    // null means "clear" and the ACP adapter rejects it loudly; undefined means
    // "no change". Collapsing them would make a refused reset look successful.
    const translated = translateModeInputs(configureMode(null));
    expect(translated.type === "session.configure" && translated.changes.mode).toBeNull();
  });

  it("returns the same object when there is nothing to translate", () => {
    const input = openWithMode("plan");
    expect(translateModeInputs(input)).toBe(input);
  });

  it("leaves unrelated inputs untouched", () => {
    const input: ProviderInput = { type: "session.interrupt", requestId: "x", sessionId: "s1" };
    expect(translateModeInputs(input)).toBe(input);
  });
});

describe("provider connect", () => {
  it("translates modes on the way to the ACP server", async () => {
    // A real ACP server is not needed: assert the wrapper the provider installs
    // rewrites what the host sends. This is the regression that broke every
    // agent stored with the -p transport's `build` mode.
    const seen: ProviderInput[] = [];
    const inner: ProviderConnection = {
      version: 1,
      capabilities: ["prompt.message", "session.configure"],
      send: async (input) => {
        seen.push(input);
      },
      onEvent: () => () => {},
      close: async () => {},
    };
    const connection = withLegacyModeTranslation(inner);
    await connection.send(openWithMode("build"));
    await connection.send(configureMode("yolo"));
    expect(seen[0].type === "session.open" && seen[0].config.mode).toBe("default");
    expect(seen[1].type === "session.configure" && seen[1].changes.mode).toBe("bypass");
    // the wrapper must not swallow the rest of the connection contract
    expect(connection.version).toBe(1);
    expect(connection.capabilities).toEqual(["prompt.message", "session.configure"]);
    await expect(connection.close()).resolves.toBeUndefined();
  });
});

describe("legacy setting translation", () => {
  it("drops the -p yolo setting, which ACP has no config option for", () => {
    // ACP advertises only `model` and `effort`. A stored featureValues.yolo
    // replayed as a config option fails the open with
    // "Unknown config option: yolo" — permission bypass is the `bypass` mode now.
    const input: ProviderInput = {
      type: "session.open",
      requestId: "o1",
      sessionId: "s1",
      config: {
        cwd: "/tmp",
        env: {},
        mcpServers: {},
        settings: { yolo: "on" },
        persist: false,
      },
      history: "skip",
    };
    const translated = translateModeInputs(input);
    expect(translated.type === "session.open" && translated.config.settings).toEqual({});
  });

  it("keeps settings ACP could still use", () => {
    const input: ProviderInput = {
      type: "session.open",
      requestId: "o1",
      sessionId: "s1",
      config: {
        cwd: "/tmp",
        env: {},
        mcpServers: {},
        settings: { keep: "yes" },
        persist: false,
      },
      history: "skip",
    };
    const translated = translateModeInputs(input);
    expect(translated.type === "session.open" && translated.config.settings).toEqual({ keep: "yes" });
  });

  it("does not mutate the caller's settings object", () => {
    const settings = { yolo: "on", other: "x" };
    const input: ProviderInput = {
      type: "session.open",
      requestId: "o1",
      sessionId: "s1",
      config: { cwd: "/tmp", env: {}, mcpServers: {}, settings, persist: false },
      history: "skip",
    };
    translateModeInputs(input);
    expect(settings).toEqual({ yolo: "on", other: "x" });
  });
});

describe("legacy yolo promotion", () => {
  function openWithSettings(settings: Record<string, string>): ProviderInput {
    return {
      type: "session.open",
      requestId: "o1",
      sessionId: "s1",
      config: { cwd: "/tmp", env: {}, mcpServers: {}, settings, persist: false },
      history: "skip",
    };
  }
  function modeOf(input: ProviderInput): string | undefined {
    return input.type === "session.open" ? input.config.mode : undefined;
  }

  it("promotes a stored yolo agent to bypass instead of silently demoting it", () => {
    // -p ran yolo:on as `--yolo --tools-all`, i.e. no permission prompts. Dropping
    // the setting without promoting would leave those agents in `default`: still
    // working, but no longer unattended, with nothing telling the user.
    const translated = translateModeInputs(openWithSettings({ yolo: "on" }));
    expect(modeOf(translated)).toBe("bypass");
  });

  it("promotes the stored build+yolo combination the way those 16 agents are", () => {
    const input: ProviderInput = {
      type: "session.open",
      requestId: "o1",
      sessionId: "s1",
      config: {
        cwd: "/tmp",
        env: {},
        mcpServers: {},
        mode: "build",
        settings: { yolo: "on" },
        persist: false,
      },
      history: "skip",
    };
    const translated = translateModeInputs(input);
    expect(modeOf(translated)).toBe("bypass");
    expect(translated.type === "session.open" && translated.config.settings).toEqual({});
  });

  it("does not override an explicit plan mode", () => {
    // -p ignored yolo while planning, so promoting here would grant more
    // permission than the agent ever had.
    const translated = translateModeInputs(
      openWithSettings({ yolo: "on" }),
    );
    expect(modeOf(translated)).toBe("bypass");
    const planned: ProviderInput = {
      type: "session.open",
      requestId: "o1",
      sessionId: "s1",
      config: {
        cwd: "/tmp",
        env: {},
        mcpServers: {},
        mode: "plan",
        settings: { yolo: "on" },
        persist: false,
      },
      history: "skip",
    };
    expect(modeOf(translateModeInputs(planned))).toBe("plan");
  });

  it("maps autoAccept to auto-accept rather than dropping it", () => {
    const translated = translateModeInputs(openWithSettings({ autoAccept: "on" }));
    expect(modeOf(translated)).toBe("auto-accept");
  });

  it("leaves an agent with yolo off alone", () => {
    const input: ProviderInput = {
      type: "session.open",
      requestId: "o1",
      sessionId: "s1",
      config: {
        cwd: "/tmp",
        env: {},
        mcpServers: {},
        mode: "build",
        settings: { yolo: "off" },
        persist: false,
      },
      history: "skip",
    };
    expect(modeOf(translateModeInputs(input))).toBe("default");
  });
});
