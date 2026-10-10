// Keep preview cleanup consistent with Streamline's Remove Markdown Syntax.swift.
const rules: [RegExp, string][] = [
  [new RegExp("<!--[\\s\\S]*?-->", "gmi"), ""],
  [new RegExp("^[`~]{3,}.*$", "gmi"), ""],
  [new RegExp("!\\[[^\\]]*\\]\\([^\\)]+\\)", "gmi"), ""],
  [new RegExp("^[-*_]{3,}\\s*$", "gmi"), ""],
  [new RegExp("^\\|.*\\|\\s*$", "gmi"), ""],
  [new RegExp("^\\|[-:\\s|]+\\|\\s*$", "gmi"), ""],
  [new RegExp("\\*\\*(.+?)\\*\\*", "gmi"), "$1"],
  [new RegExp("__(.+?)__", "gmi"), "$1"],
  [new RegExp("\\*(.+?)\\*", "gmi"), "$1"],
  [new RegExp("(?<!_)_([^_]+)_(?!_)", "gmi"), "$1"],
  [new RegExp("==(.+?)==", "gmi"), "$1"],
  [new RegExp("~~(.+?)~~", "gmi"), "$1"],
  [new RegExp("^\\#+\\s*", "gmi"), ""],
  [new RegExp("^>+\\s?", "gmi"), ""],
  [new RegExp("\\[([^\\]]+)\\]\\([^\\)]+\\)", "gmi"), "$1"],
  [new RegExp("\\[\\[([^\\]]+)\\]\\]", "gmi"), "$1"],
  [new RegExp("`([^`]+)`", "gmi"), "$1"],
  [new RegExp("\\[\\^[^\\]]+\\]", "gmi"), ""],
  [new RegExp("^\\s*[-*+]\\s*\\[[x\\s]\\]\\s*", "gmi"), ""],
  [new RegExp("^\\s*[-*+]\\s+", "gmi"), ""],
  [new RegExp("^\\s*\\d+\\.\\s+", "gmi"), ""],
];
const skipPatterns = [
  new RegExp("^[-*_]{3,}\\s*$"),
  new RegExp("^\\|[-:\\s|]+\\|\\s*$"),
  new RegExp("^[`~]{3,}"),
  new RegExp("^<!--.*-->$"),
  new RegExp("^!\\[[^\\]]*\\]\\([^\\)]+\\)\\s*$"),
  new RegExp("^\\|[\\s-:|]+\\|$"),
];
function clean(line: string): string {
  for (const [pattern, replacement] of rules) line = line.replace(pattern, replacement);
  return line.replace(/\s{2,}/g, " ").trim();
}
export function notePreview(content: string): {first: string; second: string} {
  const lines = content.split(/\r\n|[\n\r\u0085\u2028\u2029]/).filter(line => {
    const trimmed = line.trim();
    return trimmed.length > 0 && !trimmed.includes("lmde-table-config")
      && !skipPatterns.some(pattern => pattern.test(trimmed));
  }).map(clean);
  return {
    first: lines[0] ?? "",
    second: [lines[1] ?? "", [...lines.slice(2).join(" ")].slice(0, 200).join("")]
      .filter(Boolean).join(" "),
  };
}
