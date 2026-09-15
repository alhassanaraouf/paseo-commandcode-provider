import { useRef, useState } from "react";
import { useSettings } from "@getpaseo/plugin/client";
import { useToast } from "@getpaseo/plugin/client/react-native";
import type { SettingsInputHandle } from "@getpaseo/plugin/client/ui";
import { SettingsAction, SettingsCard, SettingsInput, SettingsRow, SettingsSection } from "@getpaseo/plugin/client/ui";
import { cliSettings } from "../shared/settings";

export function CliSettingsScreen() {
  const settings = useSettings(cliSettings);
  const toast = useToast();
  const [draft, setDraft] = useState<string | null>(null);
  const inputRef = useRef<SettingsInputHandle>(null);

  if (settings.status === "loading") return null;

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
      info="Leave blank to use commandcode (cmdc on Windows). Set this to point at a different alias, an absolute path, or a wrapper script."
    >
      <SettingsCard>
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
    </SettingsSection>
  );
}
