import { canonicalJson, compareUtf8Bytes } from "./canonical.js";

export { compareUtf8Bytes } from "./canonical.js";

export function compareCanonicalJsonUtf8(left: unknown, right: unknown): number {
  return compareUtf8Bytes(canonicalJson(left), canonicalJson(right));
}

export const compareCanonicalJson = compareCanonicalJsonUtf8;
