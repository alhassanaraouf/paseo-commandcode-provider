import type { PluginServerContext } from "@getpaseo/plugin/server";
import { createCommandcodeAcpProvider } from "./server/acp-provider";
import { createCommandcodeProvider } from "./server/provider";
import { cliSettings } from "./shared/settings";

export default function contribute(server: PluginServerContext) {
  server.registerSettings(cliSettings);
  // ACP is the primary transport: native images, cancel-and-continue steering,
  // real session persistence and resume. See server/acp-provider.ts.
  server.registerProvider(createCommandcodeAcpProvider());
  return () => {};
}

export { createCommandcodeProvider };
