/** Keep repository-controlled paths from creating log lines or Markdown links. */
export function safeLogPath(value: string): string {
  return JSON.stringify(value);
}

export function safeMarkdownPath(value: string): string {
  const markdown = new Set([
    "\\",
    "`",
    "*",
    "_",
    "{",
    "}",
    "[",
    "]",
    "(",
    ")",
    "#",
    "+",
    ".",
    "!",
    "|",
    "<",
    ">",
  ]);
  return [...value]
    .map((character) => {
      const code = character.codePointAt(0) ?? 0;
      if (code < 32 || (code >= 127 && code <= 159) || code === 0x2028 || code === 0x2029) {
        return "�";
      }
      return markdown.has(character) ? `\\${character}` : character;
    })
    .join("");
}
