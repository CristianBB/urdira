export type JsonSchema = Record<string, unknown>;
export type RequestPath = readonly (string | number)[];

export function schemaObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function schemaProperties(schema: JsonSchema): Record<string, JsonSchema> {
  return Object.fromEntries(Object.entries(schemaObject(schema["properties"])).map(([key, value]) => [key, schemaObject(value)]));
}

export function requiredFields(schema: JsonSchema): readonly string[] {
  return Array.isArray(schema["required"]) ? schema["required"].filter((value): value is string => typeof value === "string") : [];
}

export function schemaVariants(schema: JsonSchema): readonly JsonSchema[] {
  const variants = Array.isArray(schema["oneOf"]) ? schema["oneOf"] : Array.isArray(schema["anyOf"]) ? schema["anyOf"] : [];
  return variants.map(schemaObject);
}

export function selectSchemaVariant(schema: JsonSchema, value: unknown): number {
  const variants = schemaVariants(schema);
  const current = schemaObject(value);
  let bestIndex = 0;
  let bestScore = -1;
  variants.forEach((variant, index) => {
    let score = 0;
    for (const [key, child] of Object.entries(schemaProperties(variant))) {
      if (child["const"] !== undefined && current[key] === child["const"]) score += 10;
      else if (Array.isArray(child["enum"]) && child["enum"].includes(current[key])) score += 3;
      else if (current[key] !== undefined) score += 1;
    }
    if (score > bestScore) { bestIndex = index; bestScore = score; }
  });
  return bestIndex;
}

export function resolvedSchemaVariant(schema: JsonSchema, index: number): JsonSchema {
  const variants = schemaVariants(schema);
  const variant = variants[index] ?? variants[0] ?? {};
  const base = { ...schema };
  delete base["oneOf"];
  delete base["anyOf"];
  const baseProperties = schemaProperties(base); const variantProperties = schemaProperties(variant);
  const required = [...new Set([...requiredFields(base), ...requiredFields(variant)])];
  return {
    ...base,
    ...variant,
    ...(Object.keys(baseProperties).length === 0 && Object.keys(variantProperties).length === 0 ? {} : { properties: { ...baseProperties, ...variantProperties } }),
    ...(required.length === 0 ? {} : { required }),
  };
}

export function initialSchemaValue(schemaValue: unknown): unknown {
  const schema = schemaObject(schemaValue);
  if (schema["default"] !== undefined) return structuredClone(schema["default"]);
  if (schema["const"] !== undefined) return structuredClone(schema["const"]);
  if (Array.isArray(schema["enum"]) && schema["enum"].length > 0) return structuredClone(schema["enum"][0]);
  const variants = schemaVariants(schema);
  if (variants.length > 0) return initialSchemaValue(resolvedSchemaVariant(schema, 0));
  if (schema["type"] === "object" || schema["properties"] !== undefined) {
    const properties = schemaProperties(schema);
    return Object.fromEntries(requiredFields(schema).flatMap((key) => properties[key] === undefined ? [] : [[key, initialSchemaValue(properties[key])]]));
  }
  if (schema["type"] === "array") {
    const minimum = typeof schema["minItems"] === "number" ? schema["minItems"] : 0;
    return Array.from({ length: minimum }, () => initialSchemaValue(schema["items"]));
  }
  if (schema["type"] === "boolean") return false;
  if (schema["type"] === "integer" || schema["type"] === "number") return typeof schema["minimum"] === "number" ? schema["minimum"] : 0;
  return "";
}

export function updateRequestPath(value: unknown, path: RequestPath, next: unknown): unknown {
  if (path.length === 0) return next;
  const head = path[0]!; const tail = path.slice(1);
  if (typeof head === "number") {
    const copy = Array.isArray(value) ? [...value] : [];
    copy[head] = updateRequestPath(copy[head], tail, next);
    return copy;
  }
  return { ...schemaObject(value), [head]: updateRequestPath(schemaObject(value)[head], tail, next) };
}

export function removeRequestPath(value: unknown, path: RequestPath): unknown {
  if (path.length === 0) return undefined;
  const head = path[0]!; const tail = path.slice(1);
  if (typeof head === "number") {
    const copy = Array.isArray(value) ? [...value] : [];
    if (tail.length === 0) copy.splice(head, 1);
    else copy[head] = removeRequestPath(copy[head], tail);
    return copy;
  }
  const copy = { ...schemaObject(value) };
  if (tail.length === 0) delete copy[head];
  else copy[head] = removeRequestPath(copy[head], tail);
  return copy;
}

export function parseMcpRequest(raw: string): Record<string, unknown> {
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch (error) {
    throw new Error(`Invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("The request must be a top-level JSON object.");
  return parsed as Record<string, unknown>;
}

export function validateMcpRequest(value: unknown, schemaValue: unknown, path = "request"): string[] {
  const schema = schemaObject(schemaValue);
  const variants = schemaVariants(schema);
  if (variants.length > 0) {
    const alternatives = variants.map((_, index) => validateMcpRequest(value, resolvedSchemaVariant(schema, index), path));
    const matching = alternatives.filter((errors) => errors.length === 0);
    if (matching.length === 1) return [];
    if (matching.length > 1) return [`${path} matches more than one mutually exclusive request shape.`];
    return alternatives[selectSchemaVariant(schema, value)] ?? [`${path} does not match an accepted request shape.`];
  }
  const errors: string[] = [];
  if (schema["const"] !== undefined && value !== schema["const"]) errors.push(`${path} must be ${JSON.stringify(schema["const"])}.`);
  if (Array.isArray(schema["enum"]) && !schema["enum"].includes(value)) errors.push(`${path} must be one of ${schema["enum"].map(String).join(", ")}.`);
  if (schema["type"] === "object" || schema["properties"] !== undefined) {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return [...errors, `${path} must be an object.`];
    const current = schemaObject(value); const properties = schemaProperties(schema);
    for (const required of requiredFields(schema)) if (current[required] === undefined) errors.push(`${path}.${required} is required.`);
    for (const [key, child] of Object.entries(properties)) if (current[key] !== undefined) errors.push(...validateMcpRequest(current[key], child, `${path}.${key}`));
    if (schema["additionalProperties"] === false) for (const key of Object.keys(current)) if (properties[key] === undefined) errors.push(`${path}.${key} is not an accepted parameter.`);
    else if (schema["additionalProperties"] !== undefined && typeof schema["additionalProperties"] === "object") for (const key of Object.keys(current)) if (properties[key] === undefined) errors.push(...validateMcpRequest(current[key], schema["additionalProperties"], `${path}.${key}`));
  } else if (schema["type"] === "array") {
    if (!Array.isArray(value)) errors.push(`${path} must be a list.`);
    else {
      if (typeof schema["minItems"] === "number" && value.length < schema["minItems"]) errors.push(`${path} needs at least ${schema["minItems"]} item(s).`);
      if (typeof schema["maxItems"] === "number" && value.length > schema["maxItems"]) errors.push(`${path} accepts at most ${schema["maxItems"]} item(s).`);
      value.forEach((item, index) => errors.push(...validateMcpRequest(item, schema["items"], `${path}[${index}]`)));
    }
  } else if (schema["type"] === "string") {
    if (typeof value !== "string") errors.push(`${path} must be text.`);
    else if (typeof schema["minLength"] === "number" && value.length < schema["minLength"]) errors.push(`${path} cannot be empty.`);
    else if (typeof schema["maxLength"] === "number" && value.length > schema["maxLength"]) errors.push(`${path} must contain at most ${schema["maxLength"]} characters.`);
  } else if (schema["type"] === "boolean" && typeof value !== "boolean") errors.push(`${path} must be true or false.`);
  else if (schema["type"] === "integer" || schema["type"] === "number") {
    if (typeof value !== "number" || !Number.isFinite(value) || (schema["type"] === "integer" && !Number.isInteger(value))) errors.push(`${path} must be ${schema["type"] === "integer" ? "a whole number" : "a number"}.`);
    else {
      if (typeof schema["minimum"] === "number" && value < schema["minimum"]) errors.push(`${path} must be at least ${schema["minimum"]}.`);
      if (typeof schema["maximum"] === "number" && value > schema["maximum"]) errors.push(`${path} must be at most ${schema["maximum"]}.`);
    }
  }
  return errors;
}

export function fieldLabel(name: string): string {
  return name.replaceAll("_", " ").replaceAll("-", " ").replace(/^./u, (letter) => letter.toUpperCase());
}
