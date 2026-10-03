import type { JsonValue } from "@getpaseo/protocol/agent-types";
import type { ProviderInput } from "@getpaseo/plugin/server/provider";

// -p stored modeId "build" and yolo as a setting; ACP has neither and replays
// stored config verbatim. yolo becomes the bypass mode, not a dropped setting.

const LEGACY_MODE_ALIASES: Readonly<Record<string, string>> = {
  build: "default",
  accept_edits: "auto-accept",
  "accept-edits": "auto-accept",
  yolo: "bypass",
};

const LEGACY_SETTING_DROPS: ReadonlySet<string> = new Set(["yolo", "autoAccept"]);

const CODE_MODES: ReadonlySet<string> = new Set(["build", "default", "accept_edits", "accept-edits"]);

function isOn(value: JsonValue | undefined): boolean {
  return value === true || value === "on";
}

export function translateModeId(mode: string | null | undefined): string | null | undefined {
  if (mode == null) return mode;
  return LEGACY_MODE_ALIASES[mode] ?? mode;
}

export function translateModeInputs(input: ProviderInput): ProviderInput {
  if (input.type === "session.open") {
    const settings = translateSettings(input.config.settings);
    const mode = legacyModeForSettings(input.config.mode, input.config.settings);
    const settingsChanged = settings !== input.config.settings;
    const modeChanged = mode !== input.config.mode;
    if (!modeChanged && !settingsChanged) return input;
    return {
      ...input,
      config: {
        ...input.config,
        mode,
        ...(settingsChanged ? { settings } : {}),
      },
    };
  }
  if (input.type === "session.configure") {
    const mode = translateModeId(input.changes.mode);
    const settings =
      input.changes.settings === undefined ? undefined : translateSettings(input.changes.settings);
    const modeChanged = mode !== input.changes.mode;
    const settingsChanged = settings !== input.changes.settings;
    if (!modeChanged && !settingsChanged) return input;
    return {
      ...input,
      changes: {
        ...input.changes,
        ...(input.changes.mode === undefined ? {} : { mode }),
        ...(settingsChanged ? { settings } : {}),
      },
    };
  }
  return input;
}

function legacyModeForSettings(
  mode: string | undefined,
  settings: Readonly<Record<string, JsonValue>> | undefined,
): string | undefined {
  const translated = translateModeId(mode);
  if (translated === null) return undefined;
  if (translated === "plan") return translated;
  const promotable = translated === undefined || CODE_MODES.has(translated);
  if (promotable && settings) {
    if (isOn(settings.yolo)) return "bypass";
    if (isOn(settings.autoAccept)) return "auto-accept";
  }
  return translated ?? undefined;
}

function translateSettings(
  settings: Readonly<Record<string, JsonValue>> | undefined,
): Readonly<Record<string, JsonValue>> | undefined {
  if (!settings) return settings;
  let changed = false;
  const kept: Record<string, JsonValue> = {};
  for (const [id, value] of Object.entries(settings)) {
    if (LEGACY_SETTING_DROPS.has(id)) {
      changed = true;
      continue;
    }
    kept[id] = value;
  }
  return changed ? kept : settings;
}
