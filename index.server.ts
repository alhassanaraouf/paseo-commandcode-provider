import type { PluginServerContext } from "@getpaseo/plugin/server";
import { createCommandcodeProvider } from "./server/provider";
import { cliSettings } from "./shared/settings";

export default function contribute(server: PluginServerContext) {
  server.registerSettings(cliSettings);
  server.registerProvider(createCommandcodeProvider());
  return () => {};
}
