/** Parse `commandcode skills list` into skill entries. */

export interface SkillInfo {
  name: string;
  description?: string;
}

const SKIP_PREFIXES = ["Skills", "Global", "Project", "Bundled", "Plugin", "Managed"];

export function parseSkillsList(text: string): SkillInfo[] {
  const skills: SkillInfo[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // Section headers ("Global (9)", "Skills  9 installed") never start with a skill name pattern.
    if (SKIP_PREFIXES.some((prefix) => trimmed.startsWith(prefix))) continue;
    // Skill rows look like "  better-ui · Polishes and improves...".
    const match = /^(\S+)\s*(?:·\s*(.+))?$/.exec(trimmed);
    if (!match) continue;
    const [, name, description] = match;
    // Guard against stray prose lines (must be a single slug-like token).
    if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(name)) continue;
    skills.push({ name, ...(description?.trim() ? { description: description.trim() } : {}) });
  }
  return skills;
}
