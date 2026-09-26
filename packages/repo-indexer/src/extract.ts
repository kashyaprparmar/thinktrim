import path from "node:path";

export type SymbolKind = "class" | "function" | "method" | "interface" | "type" | "variable";
export interface SymbolRecord {
  readonly id: string;
  readonly filePath: string;
  readonly name: string;
  readonly kind: SymbolKind;
  readonly line: number;
}
export interface ImportRecord {
  readonly specifier: string;
  readonly line: number;
  readonly resolvedPath: string | null;
}

const languages: Record<string, string> = {
  ".ts": "typescript",
  ".tsx": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".py": "python",
  ".go": "go",
  ".rs": "rust",
  ".java": "java",
  ".json": "json",
  ".jsonc": "json",
  ".php": "php",
  ".rb": "ruby",
  ".cs": "csharp",
  ".c": "c",
  ".h": "c",
  ".cc": "cpp",
  ".cpp": "cpp",
  ".hpp": "cpp",
  ".swift": "swift",
  ".kt": "kotlin",
  ".kts": "kotlin",
  ".sh": "shell",
  ".bash": "shell",
  ".ps1": "powershell",
  ".sql": "sql",
  ".md": "markdown",
  ".mdx": "markdown",
  ".html": "html",
  ".css": "css",
  ".scss": "scss",
  ".yaml": "yaml",
  ".yml": "yaml",
  ".toml": "toml",
  ".xml": "xml",
  ".vue": "vue",
  ".svelte": "svelte",
};

export function languageFor(filePath: string, text: string): string | null {
  const extension = path.posix.extname(filePath).toLowerCase();
  if (languages[extension]) return languages[extension];
  if (/^#!.*\bpython\b/.test(text)) return "python";
  if (/^#!.*\b(?:node|deno|bun)\b/.test(text)) return "javascript";
  if (/^#!.*\b(?:bash|sh|zsh)\b/.test(text)) return "shell";
  return null;
}

export function extractSymbols(
  filePath: string,
  language: string | null,
  text: string,
): SymbolRecord[] {
  const result: SymbolRecord[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const matches: Array<[RegExpMatchArray | null, SymbolKind]> = [];
    if (language === "typescript" || language === "javascript") {
      matches.push(
        [line.match(/^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([\w$]+)/), "class"],
        [
          line.match(/^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([\w$]+)/),
          "function",
        ],
        [line.match(/^\s*(?:export\s+)?interface\s+([\w$]+)/), "interface"],
        [line.match(/^\s*(?:export\s+)?type\s+([\w$]+)/), "type"],
        [line.match(/^\s*(?:export\s+)?(?:const|let|var)\s+([\w$]+)/), "variable"],
      );
    } else if (language === "python") {
      matches.push(
        [line.match(/^\s*class\s+(\w+)/), "class"],
        [line.match(/^\s*(?:async\s+)?def\s+(\w+)/), /^\s/.test(line) ? "method" : "function"],
      );
    } else if (language === "go") {
      matches.push(
        [
          line.match(/^func\s+(?:\([^)]*\)\s*)?(\w+)/),
          line.startsWith("func (") ? "method" : "function",
        ],
        [line.match(/^type\s+(\w+)\s+(?:struct|interface)/), "type"],
      );
    } else if (language === "rust") {
      matches.push(
        [line.match(/^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+(\w+)/), "function"],
        [line.match(/^\s*(?:pub(?:\([^)]*\))?\s+)?(?:struct|enum|trait)\s+(\w+)/), "type"],
      );
    } else if (language === "java" || language === "csharp") {
      matches.push([
        line.match(
          /^\s*(?:(?:public|private|protected|static|final|abstract|internal)\s+)*(?:class|interface|record|enum)\s+(\w+)/,
        ),
        "class",
      ]);
    }
    for (const [match, kind] of matches) {
      const name = match?.[1];
      if (name)
        result.push({ id: `${filePath}#${name}:${i + 1}`, filePath, name, kind, line: i + 1 });
    }
  }
  return result;
}

export function extractImports(
  language: string | null,
  text: string,
): Omit<ImportRecord, "resolvedPath">[] {
  const imports: Omit<ImportRecord, "resolvedPath">[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    let specifier: string | undefined;
    if (language === "typescript" || language === "javascript") {
      specifier =
        line.match(/^\s*(?:import|export)\b.*?\bfrom\s*["']([^"']+)["']/)?.[1] ??
        line.match(/^\s*import\s*["']([^"']+)["']/)?.[1] ??
        line.match(/\b(?:require|import)\s*\(\s*["']([^"']+)["']\s*\)/)?.[1];
    } else if (language === "python") {
      specifier =
        line.match(/^\s*from\s+(\.*[\w.]+)\s+import\b/)?.[1] ??
        line.match(/^\s*import\s+([\w.]+)/)?.[1];
    } else if (language === "go") {
      specifier = line.match(/^\s*(?:import\s+)?(?:\w+\s+)?"([^"]+)"/)?.[1];
    } else if (language === "rust") {
      specifier = line.match(/^\s*(?:pub\s+)?(?:use|mod)\s+([\w:]+)/)?.[1];
    }
    if (specifier) imports.push({ specifier, line: i + 1 });
  }
  return imports;
}

const extensions = [
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".go",
  ".rs",
  ".json",
];
export function resolveImport(
  source: string,
  specifier: string,
  paths: ReadonlySet<string>,
): string | null {
  let stem: string;
  if (specifier.startsWith(".")) {
    if (source.endsWith(".py")) {
      const dots = specifier.match(/^\.+/)?.[0].length ?? 1;
      let directory = path.posix.dirname(source);
      for (let i = 1; i < dots; i++) directory = path.posix.dirname(directory);
      stem = path.posix.join(directory, specifier.slice(dots).replaceAll(".", "/"));
    } else stem = path.posix.join(path.posix.dirname(source), specifier);
  } else if (source.endsWith(".py")) stem = specifier.replaceAll(".", "/");
  else return null;
  if (stem === ".." || stem.startsWith("../") || path.posix.isAbsolute(stem)) return null;
  const runtimeExtension = /\.(?:js|jsx|mjs|cjs)$/.test(stem)
    ? stem.replace(/\.(?:js|jsx|mjs|cjs)$/, "")
    : null;
  const candidates = [
    stem,
    ...(runtimeExtension ? extensions.map((extension) => runtimeExtension + extension) : []),
    ...extensions.map((extension) => stem + extension),
    ...extensions.map((extension) => path.posix.join(stem, `index${extension}`)),
    path.posix.join(stem, "__init__.py"),
  ];
  return candidates.find((candidate) => paths.has(candidate)) ?? null;
}
