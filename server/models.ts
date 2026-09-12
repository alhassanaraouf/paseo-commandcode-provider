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

export const FALLBACK_DEFAULT = "deepseek/deepseek-v4-flash";

// ponytail: used only when `commandcode --list-models` fails; refresh if stale
export const FALLBACK_MODELS: ModelInfo[] = [
  { id: "deepseek/deepseek-v4-flash", label: "deepseek-v4-flash" },
  { id: "deepseek/deepseek-v4-pro", label: "deepseek-v4-pro" },
  { id: "moonshotai/kimi-k2.5", label: "kimi-k2.5" },
  { id: "claude-sonnet-5", label: "claude-sonnet-5" },
  { id: "claude-opus-5", label: "claude-opus-5" },
  { id: "gpt-5.5", label: "gpt-5.5" },
  { id: "google/gemini-3.5-flash", label: "gemini-3.5-flash" },
  { id: "meta/muse-spark-1.3", label: "muse-spark-1.3" },
  { id: "xai/grok-4.5", label: "grok-4.5" },
];

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
