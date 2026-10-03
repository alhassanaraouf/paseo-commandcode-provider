import { runAcpProvider } from "@getpaseo/plugin/server/acp";
import type {
  ProviderConnection,
  ProviderRegistration,
} from "@getpaseo/plugin/server/provider";
import { resolveCliInvocation } from "./cli.js";
import { translateModeInputs } from "./modes.js";
import { readSettingsDocument } from "./settings.js";
import { CLI_DEFAULTS, cliSettings } from "../shared/settings.js";

export type ProviderRegistrationWithCommand = ProviderRegistration & {
  command: readonly [string, ...string[]];
};

export function createCommandcodeAcpProvider(): ProviderRegistrationWithCommand {
  const settings = readSettingsDocument(cliSettings, CLI_DEFAULTS);
  const { command } = resolveCliInvocation(settings);
  const argv = [command, "acp"] as [string, string];
  const registration = runAcpProvider({
    id: "commandcode",
    label: "Command Code",
    description: "Command Code coding agent (ACP)",
    icon: "icon.svg",
    command: argv,
  });
  const provider = { ...registration, command: argv };
  return {
    ...provider,
    async connect(request) {
      return withLegacyModeTranslation(await provider.connect(request));
    },
  };
}

export function withLegacyModeTranslation(connection: ProviderConnection): ProviderConnection {
  return {
    version: connection.version,
    capabilities: connection.capabilities,
    send: (input) => connection.send(translateModeInputs(input)),
    onEvent: (listener) => connection.onEvent(listener),
    close: () => connection.close(),
  };
}
