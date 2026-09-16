/** Deterministic source-path and word-boundary matching shared by query ports. */

export function matchesArtifactGlob(path: string, pattern: string): boolean {
  const normalizedPath = path.replaceAll("\\", "/");
  const normalizedPattern = pattern.replaceAll("\\", "/");
  let expression = "^";
  for (let index = 0; index < normalizedPattern.length; index += 1) {
    const character = normalizedPattern[index] ?? "";
    if (character === "*" && normalizedPattern[index + 1] === "*") {
      // `**/` also matches zero directories, as in the native Glob tools.
      if (normalizedPattern[index + 2] === "/") {
        expression += "(?:.*/)?";
        index += 2;
      } else {
        expression += ".*";
        index += 1;
      }
    } else if (character === "*") expression += "[^/]*";
    else if (character === "?") expression += "[^/]";
    else expression += character.replace(/[|\\{}()[\]^$+*?.-]/g, "\\$&");
  }
  return new RegExp(`${expression}$`).test(normalizedPath);
}

export function isTestArtifactPath(path: string): boolean {
  const normalized = path.replaceAll("\\", "/").toLocaleLowerCase("en-US");
  const segments = normalized.split("/");
  const file = segments.at(-1) ?? "";
  return segments.some((segment) => segment === "test" || segment === "tests" || segment === "__tests__")
    || /(?:^|[._-])(?:test|spec)(?:[._-]|$)/u.test(file);
}

export function matchesWordMode(value: string, offset: number, length: number, mode: "substring" | "identifier" | "token"): boolean {
  if (mode === "substring") return true;
  const boundaryCharacter = mode === "identifier" ? /[$\p{ID_Continue}]/u : /[_\p{L}\p{M}\p{N}]/u;
  const before = codePointBefore(value, offset);
  const after = codePointAt(value, offset + length);
  return (before.length === 0 || !boundaryCharacter.test(before)) && (after.length === 0 || !boundaryCharacter.test(after));
}

function codePointBefore(value: string, offset: number): string {
  if (offset <= 0) return "";
  const trailing = value.charCodeAt(offset - 1);
  return trailing >= 0xdc00 && trailing <= 0xdfff && offset >= 2 ? value.slice(offset - 2, offset) : value.slice(offset - 1, offset);
}

function codePointAt(value: string, offset: number): string {
  if (offset >= value.length) return "";
  const width = (value.codePointAt(offset) ?? 0) > 0xffff ? 2 : 1;
  return value.slice(offset, offset + width);
}
