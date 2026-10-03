import { describe, expect, it } from "vitest";
import { createCommandcodeAcpProvider } from "../server/acp-provider.js";
import { resolveCliInvocation } from "../server/cli.js";

describe("ACP provider", () => {
  it("keeps the provider id and label stable so existing agents still resolve", () => {
    // agents persist this id on disk; changing it would orphan every session
    const registration = createCommandcodeAcpProvider();
    expect(registration.id).toBe("commandcode");
    expect(registration.label).toBe("Command Code");
    expect(registration.icon).toBe("icon.svg");
  });

  it("exposes the launch command so the host can resolve and override it", () => {
    // The host reads registration.command in resolveLaunch(). SDK 0.8.0's
    // runAcpProvider drops it, so the provider grafts it back; without this the
    // agent's binary override is silently ignored.
    const registration = createCommandcodeAcpProvider();
    expect(registration.command).toHaveLength(2);
    expect(registration.command[1]).toBe("acp");
    expect(registration.command[0].length).toBeGreaterThan(0);
  });

  it("spawns `<binary> acp` so the harness runs over the Agent Client Protocol", async () => {
    // ACP is what buys native images and steering: `-p` is a one-shot process
    // with no live channel, `acp` keeps a session open.
    process.env.COMMANDCODE_CLI_COMMAND = "/nonexistent/paseo-acp-probe";
    try {
      // the spawn fails, and the failure proves which argv was used
      await expect(
        createCommandcodeAcpProvider().connect({
          versions: [1],
          capabilities: ["prompt.message", "session.configure"],
        }),
      ).rejects.toThrow(/paseo-acp-probe/);
    } finally {
      delete process.env.COMMANDCODE_CLI_COMMAND;
    }
  });
});

describe("cli resolution", () => {
  const settings = { command: "" };

  it("prefers an explicit option over everything else", () => {
    expect(resolveCliInvocation(settings, {}, "/opt/bin/cc")).toEqual({
      command: "/opt/bin/cc",
      source: "option",
    });
  });

  it("falls back to env override, then settings, then the platform default", () => {
    expect(resolveCliInvocation(settings, { COMMANDCODE_CLI_COMMAND: "cmd-wrapper" })).toEqual({
      command: "cmd-wrapper",
      source: "env",
    });
    expect(resolveCliInvocation({ command: "from-settings" }, {})).toEqual({
      command: "from-settings",
      source: "settings",
    });
    expect(resolveCliInvocation(settings, {}).source).toBe("default");
  });

  it("defaults to cmdc on Windows, where a commandcode shim is not guaranteed", () => {
    const platform = process.platform;
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    try {
      expect(resolveCliInvocation(settings, {}).command).toBe("cmdc");
    } finally {
      Object.defineProperty(process, "platform", { value: platform, configurable: true });
    }
  });

  it("never yields an empty command, whatever the inputs", () => {
    // regression: `??` let a whitespace-only env var through as "", so the
    // spawn became spawn("", ["acp"]). Assert the resolved command, not the
    // source — source was "default" while command was broken.
    const platformDefault = process.platform === "win32" ? "cmdc" : "commandcode";
    const inputs: Array<[{ command: string }, NodeJS.ProcessEnv]> = [
      [{ command: "" }, {}],
      [{ command: "   " }, {}],
      [{ command: "" }, { COMMANDCODE_CLI_COMMAND: "" }],
      [{ command: "" }, { COMMANDCODE_CLI_COMMAND: "  " }],
      [{ command: "   " }, { COMMANDCODE_CLI_COMMAND: "\t\n" }],
    ];
    for (const [input, env] of inputs) {
      const resolved = resolveCliInvocation(input, env);
      expect(resolved.command).toBe(platformDefault);
      expect(resolved.command.length).toBeGreaterThan(0);
    }
  });
});
