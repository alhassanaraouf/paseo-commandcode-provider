import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { SettingsDefinition } from "@getpaseo/plugin";
import type { ZodType, output as ZodOutput } from "zod";

/**
 * The SDK has no server-side settings read, so server modules read the
 * document the daemon persists for this plugin:
 * $PASEO_HOME/plugin-settings/commandcode-provider/<settingsId>.json, an
 * envelope `{ version, values }` written atomically by the host. Anything
 * unreadable, from another schema version, or invalid yields the defaults.
 */
function paseoHome(): string {
  const raw = process.env.PASEO_HOME?.trim();
  if (!raw) return join(homedir(), ".paseo");
  return resolve(raw === "~" ? homedir() : raw.startsWith("~/") ? join(homedir(), raw.slice(2)) : raw);
}

function settingsPath(settingsId: string): string {
  return join(paseoHome(), "plugin-settings", "commandcode-provider", `${settingsId}.json`);
}

export function readSettingsDocument<Schema extends ZodType>(
  definition: SettingsDefinition<Schema>,
  defaults: ZodOutput<Schema>,
): ZodOutput<Schema> {
  try {
    const path = settingsPath(definition.id);
    if (!existsSync(path)) return defaults;
    const envelope = JSON.parse(readFileSync(path, "utf8")) as { version?: unknown; values?: unknown };
    if (envelope.version !== definition.version) return defaults;
    const parsed = definition.schema.safeParse(envelope.values ?? {});
    return parsed.success ? (parsed.data as ZodOutput<Schema>) : defaults;
  } catch {
    return defaults;
  }
}
