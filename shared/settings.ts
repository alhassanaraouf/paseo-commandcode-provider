import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

/**
 * Host-scoped override for the CLI binary this provider spawns. Stored by
 * Paseo under `$PASEO_HOME/plugin-settings/commandcode-provider/cli.json`.
 * An empty string means "use the platform default" (commandcode, or cmdc on
 * Windows) — see server/provider.ts.
 */
export const cliSettings = defineSettings({
  id: "cli",
  scope: "host",
  version: 1,
  schema: z.object({
    command: z
      .string()
      .default("")
      .describe("Override the commandcode CLI binary: a PATH name, alias, or absolute path"),
  }),
});

export type CliSettings = z.infer<typeof cliSettings.schema>;

export const CLI_DEFAULTS: CliSettings = cliSettings.schema.parse({});
