/** Parse `commandcode --list-models` into provider models. */

export interface ModelInfo {
  id: string;
  label: string;
  description?: string;
}

export interface ModelList {
  models: ModelInfo[];
  defaultId?: string;
}

const SKIP_PREFIXES = ["Available", "Pass", "Docs:"];

export function parseListModels(text: string): ModelList {
  const models: ModelInfo[] = [];
  let defaultId: string | undefined;
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || SKIP_PREFIXES.some((prefix) => trimmed.startsWith(prefix))) continue;
    const match = /^(\S+)\s+(.+)$/.exec(trimmed);
    if (!match) continue;
    const [, id, rest] = match;
    // Section headers ("Anthropic") and usage hints ("cmd") lack id punctuation.
    if (!/[/\-:]/.test(id)) continue;
    if (rest.includes("(default)")) defaultId = id;
    const description = rest.replace(/\s*\((default|recommended)\)/g, "").trim() || undefined;
    models.push({ id, label: id.split("/").pop()?.split(":")[0] ?? id, ...(description ? { description } : {}) });
  }
  return { models, defaultId };
}
