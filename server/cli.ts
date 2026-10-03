// Windows: `cmd` is the shell, so the default there is `cmdc`.
export interface CliInvocation {
  command: string;
  source: "option" | "env" | "settings" | "default";
}

export function resolveCliInvocation(
  settings: { command: string },
  env: NodeJS.ProcessEnv = process.env,
  option?: string,
): CliInvocation {
  const platformDefault = process.platform === "win32" ? "cmdc" : "commandcode";
  const configured = settings.command.trim();
  const envOverride = env.COMMANDCODE_CLI_COMMAND?.trim();
  const command = option || envOverride || configured || platformDefault;
  const source: CliInvocation["source"] =
    option || envOverride ? (option ? "option" : "env") : configured ? "settings" : "default";
  return { command, source };
}
