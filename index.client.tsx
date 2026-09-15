import type { PluginClientContext } from "@getpaseo/plugin/client";
import { CliSettingsScreen } from "./client/settings";

export default function contribute(client: PluginClientContext) {
  client.addSettingsScreen({
    id: "cli",
    title: "Command Code",
    icon: "Terminal",
    Component: CliSettingsScreen,
  });
  return () => {};
}
