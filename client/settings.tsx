import { useRef, useState } from "react";
import { useSettings } from "@getpaseo/plugin/client";
import { useToast } from "@getpaseo/plugin/client/react-native";
import type { SettingsInputHandle } from "@getpaseo/plugin/client/ui";
import { SettingsAction, SettingsCard, SettingsInput, SettingsRow, SettingsSection } from "@getpaseo/plugin/client/ui";
import { cliSettings } from "../shared/settings";

const PLATFORM_DEFAULT = "commandcode";

export function CliSettingsScreen() {
  const settings = useSettings(cliSettings);
  const toast = useToast();
  const [draft, setDraft] = useState<string | null>(null);
  const inputRef = useRef<SettingsInputHandle>(null);

  if (settings.status === "loading") {
    return (
      <SettingsSection title="Command Code">
        <SettingsRow label="CLI binary" hint="Loading settings…" />
      </SettingsSection>
    );
  }

  if (settings.status !== "ready") {
    return (
      <SettingsSection title="Command Code">
        <SettingsRow label="CLI binary" error={settings.error} />
        <SettingsAction label="Try again" actionLabel="Reload" onPress={settings.reload} />
        {settings.status === "invalid" ? (
          <SettingsAction label="Restore default settings" actionLabel="Reset" onPress={settings.reset} />
        ) : null}
      </SettingsSection>
    );
  }

  const { values, revision, saving, saveError, save } = settings;
  const current = draft ?? values.command;
  const dirty = current !== values.command;
  const effective = current.trim() || PLATFORM_DEFAULT;

  async function apply(command: string) {
    const ok = await save({ ...values, command }, revision);
    if (ok) {
      setDraft(null);
      inputRef.current?.replaceText(command);
      toast.show("Command Code settings saved.", { variant: "success" });
    } else {
      toast.error("Failed to save Command Code settings.");
    }
  }

  function reset() {
    inputRef.current?.replaceText("");
    setDraft("");
    void apply("");
  }

  return (
    <SettingsSection
      title="Command Code"
      info="Leave blank to use commandcode (cmdc on Windows). Set this to point at a different alias, an absolute path, or a wrapper script. The COMMANDCODE_CLI_COMMAND env var on an agent overrides this."
    >
      <SettingsCard>
        <SettingsRow
          label={`Effective binary: ${effective}`}
          hint={current.trim() ? "Using your custom binary." : `Using the platform default (${PLATFORM_DEFAULT}).`}
        />
        <SettingsInput
          ref={inputRef}
          label="CLI binary"
          hint="e.g. commandcode, cmdc, or /usr/local/bin/commandcode"
          error={saveError}
          initialValue={values.command}
          placeholder="commandcode"
          onChangeText={setDraft}
          disabled={saving}
        />
        <SettingsAction
          label="Apply"
          actionLabel={saving ? "Saving…" : "Save"}
          disabled={saving || !dirty}
          onPress={() => void apply(current)}
        />
        <SettingsAction
          label="Default"
          actionLabel="Reset to platform default"
          disabled={saving || current === ""}
          onPress={reset}
        />
      </SettingsCard>
      <SettingsCard>
        <SettingsRow
          label="Troubleshooting"
          hint="Not starting? Check the binary is on PATH, then run `commandcode status` (or `commandcode login`) in a terminal. Run `paseo plugin logs commandcode-provider` for the exact spawn error."
        />
      </SettingsCard>
    </SettingsSection>
  );
}
