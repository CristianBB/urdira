export interface PortMaterializationLimits {
  readonly max_items: number;
  readonly max_depth: number;
  readonly max_nodes: number;
  readonly max_bytes: number;
}

type Assignment = (value: unknown) => void;

type MaterializationFrame =
  | { readonly frame_type: "value"; readonly value: unknown; readonly depth: number; readonly assign: Assignment }
  | { readonly frame_type: "array"; readonly source: readonly unknown[]; readonly target: unknown[]; readonly index: number; readonly length: number; readonly depth: number }
  | { readonly frame_type: "object"; readonly source: Record<string, unknown>; readonly target: Record<string, unknown>; readonly keys: readonly string[]; readonly index: number; readonly depth: number }
  | { readonly frame_type: "leave"; readonly source: object };

function validLimits(value: PortMaterializationLimits | undefined): value is PortMaterializationLimits {
  if (value === undefined || value === null || typeof value !== "object" || Object.keys(value).sort().join(",") !== "max_bytes,max_depth,max_items,max_nodes") return false;
  return [value.max_items, value.max_depth, value.max_nodes, value.max_bytes]
    .every((limit) => Number.isSafeInteger(limit) && limit >= 0);
}

function chargeUtf8(value: string, remaining: number): number {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit <= 0x7f) bytes += 1;
    else if (codeUnit <= 0x7ff) bytes += 2;
    else if (codeUnit >= 0xd800 && codeUnit <= 0xdbff && index + 1 < value.length && value.charCodeAt(index + 1) >= 0xdc00 && value.charCodeAt(index + 1) <= 0xdfff) {
      bytes += 4;
      index += 1;
    } else bytes += 3;
    if (bytes > remaining) throw new Error("Foreign port result exceeded its materialization byte limit.");
  }
  return bytes;
}

export function materializePortResult<T>(value: T, limits?: PortMaterializationLimits): T {
  if (!validLimits(limits)) throw new Error("Foreign port result materialization requires exact limits.");
  let root: unknown;
  let nodes = 0;
  let bytes = 0;
  const seen = new Set<object>();
  const frames: MaterializationFrame[] = [{ frame_type: "value", value, depth: 0, assign: (owned) => { root = owned; } }];

  const chargeNode = (depth: number): void => {
    nodes += 1;
    if (nodes > limits.max_nodes || depth > limits.max_depth) throw new Error("Foreign port result exceeded its materialization structure limits.");
  };
  const chargeString = (text: string): void => {
    bytes += chargeUtf8(text, limits.max_bytes - bytes);
  };

  while (frames.length > 0) {
    const frame = frames.pop()!;
    if (frame.frame_type === "leave") {
      seen.delete(frame.source);
      continue;
    }
    if (frame.frame_type === "array") {
      if (frame.index >= frame.length) continue;
      frames.push({ ...frame, index: frame.index + 1 });
      const item = frame.source[frame.index];
      frames.push({ frame_type: "value", value: item, depth: frame.depth + 1, assign: (owned) => { frame.target[frame.index] = owned; } });
      continue;
    }
    if (frame.frame_type === "object") {
      if (frame.index >= frame.keys.length) continue;
      const key = frame.keys[frame.index]!;
      frames.push({ ...frame, index: frame.index + 1 });
      chargeString(key);
      const item = frame.source[key];
      frames.push({
        frame_type: "value",
        value: item,
        depth: frame.depth + 1,
        assign: (owned) => {
          Object.defineProperty(frame.target, key, { value: owned, enumerable: true, configurable: true, writable: true });
        },
      });
      continue;
    }

    chargeNode(frame.depth);
    const item = frame.value;
    if (item === null || typeof item !== "object") {
      if (typeof item === "string") chargeString(item);
      else if (typeof item === "number" || typeof item === "bigint") bytes += 8;
      else if (typeof item === "boolean") bytes += 1;
      if (bytes > limits.max_bytes) throw new Error("Foreign port result exceeded its materialization byte limit.");
      frame.assign(item);
      continue;
    }
    if (seen.has(item)) throw new Error("Foreign port result contains a cycle or repeated object reference.");
    seen.add(item);

    if (item instanceof Uint8Array) {
      const length = item.byteLength;
      if (!Number.isSafeInteger(length) || length < 0 || length > limits.max_bytes - bytes) {
        throw new Error("Foreign port result exceeded its materialization byte limit.");
      }
      bytes += length;
      frame.assign(new Uint8Array(item));
      seen.delete(item);
      continue;
    }

    if (Array.isArray(item)) {
      const length = item.length;
      if (!Number.isSafeInteger(length) || length < 0 || length > limits.max_items || length > limits.max_nodes - nodes) {
        throw new Error("Foreign port result exceeded its materialization item limit.");
      }
      const owned = new Array<unknown>(length);
      frame.assign(owned);
      if (length > 0) {
        if (frame.depth >= limits.max_depth) throw new Error("Foreign port result exceeded its materialization depth limit.");
        frames.push({ frame_type: "leave", source: item });
        frames.push({ frame_type: "array", source: item, target: owned, index: 0, length, depth: frame.depth });
      } else seen.delete(item);
      continue;
    }

    const prototype = Object.getPrototypeOf(item);
    if (prototype !== Object.prototype && prototype !== null) throw new Error("Foreign port result requires plain objects.");
    const keys = Object.keys(item);
    if (keys.length > limits.max_items || keys.length > limits.max_nodes - nodes) throw new Error("Foreign port result exceeded its materialization item limit.");
    const owned: Record<string, unknown> = {};
    frame.assign(owned);
    if (keys.length > 0) {
      if (frame.depth >= limits.max_depth) throw new Error("Foreign port result exceeded its materialization depth limit.");
      frames.push({ frame_type: "leave", source: item });
      frames.push({ frame_type: "object", source: item as Record<string, unknown>, target: owned, keys, index: 0, depth: frame.depth });
    } else seen.delete(item);
  }

  return root as T;
}
