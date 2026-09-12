import type { PluginServerContext } from "@getpaseo/plugin/server";
import { createCommandcodeProvider } from "./server/provider";

export default function contribute(server: PluginServerContext) {
  server.registerProvider(createCommandcodeProvider());
  return () => {};
}
