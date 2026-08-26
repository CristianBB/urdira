import React from "react";
import { fieldLabel, initialSchemaValue, requiredFields, resolvedSchemaVariant, schemaObject as object, schemaProperties, schemaVariants, selectSchemaVariant, type JsonSchema } from "./mcp-request-schema.js";

function discriminatorValue(schema: JsonSchema): string | number | boolean | undefined {
  for (const child of Object.values(schemaProperties(schema))) {
    if (["string", "number", "boolean"].includes(typeof child["const"])) return child["const"] as string | number | boolean;
  }
  return undefined;
}

function variantLabel(schema: JsonSchema, index: number): string {
  const discriminator = discriminatorValue(schema);
  return discriminator === undefined ? `Option ${index + 1}` : fieldLabel(String(discriminator).replace(/^core:/u, ""));
}

function JsonObjectEditor({ value, onChange }: { value: unknown; onChange: (value: unknown) => void }): React.JSX.Element {
  const serialized = JSON.stringify(value ?? {}, null, 2);
  const [raw, setRaw] = React.useState(serialized);
  const [error, setError] = React.useState("");
  React.useEffect(() => { setRaw(serialized); setError(""); }, [serialized]);
  return <div className="schema-json-field"><textarea value={raw} spellCheck={false} onChange={(event) => {
    const next = event.target.value; setRaw(next);
    try {
      const parsed = JSON.parse(next) as unknown;
      if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Enter a JSON object.");
      setError(""); onChange(parsed);
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
  }}/>{error && <small className="schema-error">{error}</small>}</div>;
}

interface SchemaFieldProps {
  readonly name?: string;
  readonly schema: JsonSchema;
  readonly value: unknown;
  readonly required?: boolean;
  readonly depth?: number;
  readonly onChange: (value: unknown) => void;
  readonly onRemove?: (() => void) | undefined;
}

function SchemaField({ name, schema, value, required = false, depth = 0, onChange, onRemove }: SchemaFieldProps): React.JSX.Element {
  const variants = schemaVariants(schema);
  const description = typeof schema["description"] === "string" ? schema["description"] : undefined;
  const label = name === undefined ? undefined : fieldLabel(name);
  if (variants.length > 0) {
    const selected = selectSchemaVariant(schema, value);
    const selectedSchema = { ...resolvedSchemaVariant(schema, selected) };
    if (selectedSchema["description"] === description) delete selectedSchema["description"];
    return <fieldset className="schema-group schema-variant"><legend>{label ?? "Choose a request shape"}{required ? " *" : ""}</legend>{description && <p>{description}</p>}<div className="schema-variant-tabs">{variants.map((variant, index) => <button type="button" key={index} className={selected === index ? "active" : ""} onClick={() => onChange(initialSchemaValue(resolvedSchemaVariant(schema, index)))}>{variantLabel(variant, index)}</button>)}</div><SchemaField schema={selectedSchema} value={value} depth={depth + 1} onChange={onChange}/></fieldset>;
  }
  if (schema["type"] === "object" || schema["properties"] !== undefined) {
    const properties = schemaProperties(schema); const requiredNames = new Set(requiredFields(schema)); const current = object(value);
    if (Object.keys(properties).length === 0) return <label className="schema-field schema-free-object"><span>{label ?? "JSON object"}{required ? " *" : ""}{onRemove && <button type="button" className="schema-remove" onClick={onRemove}>Remove</button>}</span>{description && <small>{description}</small>}<JsonObjectEditor value={current} onChange={onChange}/></label>;
    const visible = Object.keys(properties).filter((key) => requiredNames.has(key) || current[key] !== undefined);
    const optional = Object.keys(properties).filter((key) => !requiredNames.has(key) && current[key] === undefined);
    const content = <>{description && <p>{description}</p>}<div className="schema-fields">{visible.map((key) => <SchemaField key={key} name={key} schema={properties[key]!} value={current[key]} required={requiredNames.has(key)} depth={depth + 1} onChange={(next) => onChange({ ...current, [key]: next })} onRemove={requiredNames.has(key) ? undefined : () => { const next = { ...current }; delete next[key]; onChange(next); }}/>)}</div>{optional.length > 0 && <label className="schema-add"><span>Add an optional parameter</span><select value="" onChange={(event) => { const key = event.target.value; if (key) onChange({ ...current, [key]: initialSchemaValue(properties[key]) }); }}><option value="">Choose a parameter…</option>{optional.map((key) => <option key={key} value={key}>{fieldLabel(key)}</option>)}</select></label>}</>;
    return name === undefined && depth === 0 ? <div className="schema-root">{content}</div> : <fieldset className="schema-group"><legend>{label}{required ? " *" : ""}{onRemove && <button type="button" className="schema-remove" onClick={onRemove}>Remove</button>}</legend>{content}</fieldset>;
  }
  if (schema["type"] === "array") {
    const items = object(schema["items"]); const list = Array.isArray(value) ? value : []; const enumItems = Array.isArray(items["enum"]) ? items["enum"] : undefined;
    if (enumItems !== undefined) return <fieldset className="schema-group schema-choice-list"><legend>{label}{required ? " *" : ""}{onRemove && <button type="button" className="schema-remove" onClick={onRemove}>Remove</button>}</legend>{description && <p>{description}</p>}<div>{enumItems.map((choice) => <label key={String(choice)}><input type="checkbox" checked={list.includes(choice)} onChange={(event) => onChange(event.target.checked ? [...list, choice] : list.filter((entry) => entry !== choice))}/><span>{fieldLabel(String(choice).replace(/^core:/u, ""))}</span></label>)}</div></fieldset>;
    return <fieldset className="schema-group schema-array"><legend>{label}{required ? " *" : ""}{onRemove && <button type="button" className="schema-remove" onClick={onRemove}>Remove</button>}</legend>{description && <p>{description}</p>}<div className="schema-array-items">{list.map((item, index) => <div className="schema-array-item" key={index}><SchemaField name={`Item ${index + 1}`} schema={items} value={item} onChange={(next) => { const copy = [...list]; copy[index] = next; onChange(copy); }} onRemove={() => onChange(list.filter((_, itemIndex) => itemIndex !== index))}/></div>)}</div><button type="button" className="button secondary schema-add-item" onClick={() => onChange([...list, initialSchemaValue(items)])}>+ Add item</button></fieldset>;
  }
  if (schema["type"] === "boolean") return <label className="schema-boolean"><input type="checkbox" checked={value === true} onChange={(event) => onChange(event.target.checked)}/><span><b>{label}{required ? " *" : ""}</b>{description && <small>{description}</small>}</span>{onRemove && <button type="button" className="schema-remove" onClick={onRemove}>Remove</button>}</label>;
  const enumeration = Array.isArray(schema["enum"]) ? schema["enum"] : undefined;
  const constant = schema["const"];
  return <label className="schema-field"><span>{label}{required ? " *" : ""}{onRemove && <button type="button" className="schema-remove" onClick={onRemove}>Remove</button>}</span>{description && <small>{description}</small>}{constant !== undefined ? <input value={String(constant)} disabled/> : enumeration !== undefined ? <select value={String(value ?? "")} onChange={(event) => onChange(event.target.value)}>{enumeration.map((entry) => <option key={String(entry)} value={String(entry)}>{fieldLabel(String(entry).replace(/^core:/u, ""))}</option>)}</select> : schema["type"] === "integer" || schema["type"] === "number" ? <input type="number" value={typeof value === "number" ? value : ""} min={typeof schema["minimum"] === "number" ? schema["minimum"] : undefined} onChange={(event) => onChange(event.target.value === "" ? "" : Number(event.target.value))}/> : <input value={typeof value === "string" ? value : ""} placeholder={description} onChange={(event) => onChange(event.target.value)}/>}</label>;
}

export function McpRequestBuilder({ schema, value, onChange }: { readonly schema: unknown; readonly value: Record<string, unknown>; readonly onChange: (value: Record<string, unknown>) => void }): React.JSX.Element {
  return <SchemaField schema={object(schema)} value={value} onChange={(next) => onChange(object(next))}/>;
}
