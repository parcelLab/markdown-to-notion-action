export function readInput(name: string, envFallbacks: string[]): string {
  const coreValue = process.env[`INPUT_${name.toUpperCase()}`];
  if (coreValue) {
    return coreValue.trim();
  }

  for (const env of envFallbacks) {
    const value = process.env[env];
    if (value) {
      return value.trim();
    }
  }

  return "";
}

export function normalizeTitlePrefixSeparator(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "→";
  }
  return trimmed;
}

export function normalizePrivateMarkdownPrefix(value: string): string | null {
  const normalized = value.trim();
  if (!normalized) {
    return "_";
  }
  if (["null", "none", "false"].includes(normalized.toLowerCase())) {
    return null;
  }
  return normalized;
}
