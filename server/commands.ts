/** Provider-side slash commands: headless-safe `commandcode` subcommands. */

export interface CommandDef {
  name: string;
  description: string;
  argumentHint?: string;
  /** CLI argv after `commandcode`. `{args}` is replaced with command arguments. */
  argv: string[];
  /** Whether output stays visible as a timeline notice (default: side-effect completion). */
  showOutput?: boolean;
  /** Commands allowed to run while a turn is active. */
  allowWhileRunning?: boolean;
}

export const COMMANDS: CommandDef[] = [
  {
    name: "status",
    description: "Show Command Code auth status",
    argv: ["status"],
    showOutput: true,
    allowWhileRunning: true,
  },
  {
    name: "info",
    description: "Show Command Code system information",
    argv: ["info"],
    showOutput: true,
    allowWhileRunning: true,
  },
  {
    name: "taste-list",
    description: "List taste packages (project, global, remote)",
    argv: ["taste", "list"],
    showOutput: true,
    allowWhileRunning: true,
  },
  {
    name: "taste-learn",
    description: "Learn taste from a repo: /taste-learn [path|owner/repo]",
    argumentHint: "[path|owner/repo]",
    argv: ["taste", "learn", "{args}"],
    allowWhileRunning: true,
  },
  {
    name: "skills-list",
    description: "List installed skills",
    argv: ["skills", "list"],
    showOutput: true,
    allowWhileRunning: true,
  },
  {
    name: "skills-add",
    description: "Install a skill: /skills-add <owner/repo>",
    argumentHint: "<owner/repo>",
    argv: ["skills", "add", "{args}"],
    allowWhileRunning: true,
  },
  {
    name: "mods-list",
    description: "List loaded mods",
    argv: ["mods", "list"],
    showOutput: true,
    allowWhileRunning: true,
  },
  {
    name: "mods-add",
    description: "Install a mod: /mods-add <npm-name|owner/repo|path>",
    argumentHint: "<source>",
    argv: ["mods", "add", "{args}"],
    allowWhileRunning: true,
  },
  {
    name: "mcp-list",
    description: "List configured MCP servers",
    argv: ["mcp", "list"],
    showOutput: true,
    allowWhileRunning: true,
  },
  {
    name: "models",
    description: "List available models",
    argv: ["--list-models"],
    showOutput: true,
    allowWhileRunning: true,
  },
];

export function findCommand(name: string): CommandDef | undefined {
  return COMMANDS.find((command) => command.name === name);
}

export function commandArgv(def: CommandDef, args: string): string[] | { error: string } {
  const trimmed = args.trim();
  const expanded = def.argv.flatMap((token) => {
    if (!token.includes("{args}")) return [token];
    if (!trimmed) return [];
    return token === "{args}" ? [trimmed] : [token.replace("{args}", trimmed)];
  });
  if (def.argv.some((token) => token.includes("{args}")) && !trimmed) {
    return { error: `/${def.name} needs an argument${def.argumentHint ? ` ${def.argumentHint}` : ""}` };
  }
  return expanded;
}
