import React, { useEffect, useState } from "react";
import { structuredCollectionLayout } from "./presentation.js";
import { pageNavigation, presentResultPage, type PresentedResult } from "./result-presentation.js";

export type JsonRecord = Record<string, unknown>;
export const record = (value: unknown): JsonRecord => value !== null && typeof value === "object" && !Array.isArray(value) ? value as JsonRecord : {};
const firstString = (...values: unknown[]): string | undefined => values.find((value): value is string => typeof value === "string" && value.length > 0);

export function pageFromResult(result: unknown): JsonRecord {
  return record(record(result)["structuredContent"])["page"] as JsonRecord ?? {};
}

export function errorFromResult(result: unknown): string | undefined {
  const error = record(record(result)["structuredContent"])["error"];
  if (error === undefined) return undefined;
  const value = record(error);
  return firstString(value["message"], value["code"]) ?? "The operation could not be completed.";
}

export function RawInspector({ value, label = "Advanced / Raw inspector" }: { value: unknown; label?: string }): React.JSX.Element | null {
  if (value === undefined) return null;
  return <details className="raw-inspector"><summary>{label}</summary><pre>{JSON.stringify(value, null, 2)}</pre></details>;
}

function Primitive({ value }: { value: unknown }): React.JSX.Element {
  if (value === null || value === undefined) return <span className="muted">—</span>;
  if (typeof value === "boolean") return <span className={`pill ${value ? "success" : "neutral"}`}>{value ? "Yes" : "No"}</span>;
  return <span>{String(value)}</span>;
}

export function StructuredView({ value, depth = 0 }: { value: unknown; depth?: number }): React.JSX.Element {
  if (depth > 3) return <span className="muted">More details available in Advanced</span>;
  if (Array.isArray(value)) {
    if (value.length === 0) return <div className="empty-inline">No entries</div>;
    const records = value.filter((entry) => Object.keys(record(entry)).length > 0);
    if (records.length === value.length) {
      const normalized = records.map((entry) => record(entry));
      const keys = [...new Set(normalized.flatMap((entry) => Object.keys(entry)))].slice(0, 8);
      if (structuredCollectionLayout(normalized) === "cards") return <div className="structured-cards">{normalized.map((entry, index) => <article className="structured-card" key={index}><dl>{keys.map((key) => <React.Fragment key={key}><dt>{key.replaceAll("_", " ")}</dt><dd><StructuredView value={entry[key]} depth={depth + 1}/></dd></React.Fragment>)}</dl></article>)}</div>;
      return <div className="table-wrap"><table><thead><tr>{keys.map((key) => <th key={key}>{key.replaceAll("_", " ")}</th>)}</tr></thead><tbody>{records.map((entry, index) => <tr key={index}>{keys.map((key) => <td key={key}><StructuredView value={record(entry)[key]} depth={depth + 1}/></td>)}</tr>)}</tbody></table></div>;
    }
    return <ul className="plain-list">{value.map((entry, index) => <li key={index}><StructuredView value={entry} depth={depth + 1}/></li>)}</ul>;
  }
  const valueRecord = record(value);
  if (Object.keys(valueRecord).length === 0) return <Primitive value={value}/>;
  return <dl className="detail-grid">{Object.entries(valueRecord).slice(0, 18).map(([key, entry]) => <React.Fragment key={key}><dt>{key.replaceAll("_", " ")}</dt><dd><StructuredView value={entry} depth={depth + 1}/></dd></React.Fragment>)}</dl>;
}

export function StatusStrip({ page, hiddenGenerated = 0, shownResults = 0, totalResults = 0, pageNumber = 1 }: { page: JsonRecord; hiddenGenerated?: number; shownResults?: number; totalResults?: number; pageNumber?: number }): React.JSX.Element | null {
  if (Object.keys(page).length === 0) return null;
  const freshness = record(page["index_freshness"]);
  const completeness = record(page["completeness_report"]);
  const truncation = record(page["truncation"]);
  return <div className="status-strip" aria-label="Query status">
    <span>Page <b>{pageNumber}</b></span>
    <span><b>{shownResults}</b> shown · <b>{totalResults}</b> total</span>
    <span className={freshness["status"] === "current" ? "ok" : "warn"}>Snapshot: <b>{String(freshness["status"] ?? "reported")}</b></span>
    <span>Coverage: <b>{String(completeness["overall_status"] ?? "reported")}</b></span>
    {truncation["truncated"] === true && <span className="warn">Response budget limited</span>}
    {hiddenGenerated > 0 && <span className="quiet">{hiddenGenerated} generated {hiddenGenerated === 1 ? "item" : "items"} hidden</span>}
  </div>;
}

export function QueryProgress({ label }: { label: string }): React.JSX.Element {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => { const timer = window.setInterval(() => setSeconds((value) => value + 1), 1_000); return () => window.clearInterval(timer); }, []);
  const detail = seconds < 3 ? "Reading the current indexed snapshot…" : seconds < 7 ? "Building an exact result without sampling…" : "This workspace is large; the operation is still active.";
  return <div className="state-card progress-state" role="status"><span className="spinner"/><div><b>{label}</b><span>{detail} {seconds > 0 && `${seconds}s`}</span></div></div>;
}

function CodeViewer({ text, startLine = 1 }: { text: string; startLine?: number | undefined }): React.JSX.Element {
  const lines = text.replace(/\n$/u, "").split("\n");
  return <div className="code-viewer" role="region" aria-label={`Source code starting at line ${startLine}`}>{lines.map((line, index) => <div className="code-line" key={index}><span className="line-number">{startLine + index}</span><code>{line || " "}</code></div>)}</div>;
}

function ResultMeta({ item }: { item: PresentedResult }): React.JSX.Element {
  return <div className="result-card-top"><span className={`classification ${item.rawClassification}`}>{item.classification}</span><span className="kind">{item.kind}</span>{item.confidence && <span className="score">{item.confidence} confidence</span>}</div>;
}

function TechnicalDetails({ item }: { item: PresentedResult }): React.JSX.Element {
  return <details className="technical-details"><summary>Technical details and evidence</summary>{item.technicalIds.length > 0 && <div className="technical-id-list"><span>Internal identifiers</span>{item.technicalIds.map((id) => <code key={id}>{id}</code>)}</div>}<StructuredView value={item.raw}/></details>;
}

function ResultLocation({ item }: { item: PresentedResult }): React.JSX.Element | null {
  if (item.path === undefined) return null;
  return <div className="result-location"><span>{item.path}</span>{item.line !== undefined && <b>Line {item.line}{item.endLine !== undefined && item.endLine !== item.line ? `–${item.endLine}` : ""}</b>}</div>;
}

function SearchResult({ item }: { item: PresentedResult }): React.JSX.Element {
  return <article className="result-card human-result"><ResultMeta item={item}/><h3>{item.title}</h3><ResultLocation item={item}/>{item.explanation && <p className="match-explanation">{item.explanation}</p>}{item.snippet && <CodeViewer text={item.snippet} startLine={item.line}/>}<TechnicalDetails item={item}/></article>;
}

function SearchResults({ items, exactMatches = false }: { items: readonly PresentedResult[]; exactMatches?: boolean }): React.JSX.Element {
  if (!exactMatches) return <div className="result-list">{items.map((item, index) => <SearchResult item={item} key={`${item.title}-${item.path}-${item.line ?? index}`}/>)}</div>;
  const files = new Map<string, PresentedResult[]>();
  for (const item of items) {
    const key = item.path ?? item.title;
    files.set(key, [...(files.get(key) ?? []), item]);
  }
  return <div className="search-files">{[...files.entries()].map(([path, occurrences]) => <article className="search-file" key={path}>
    <header><div><span className="kind">File</span><h3>{path.split("/").at(-1) ?? path}</h3><p>{path}</p></div><strong>{occurrences.length} {occurrences.length === 1 ? "match" : "matches"}</strong></header>
    <div className="search-occurrences">{occurrences.map((item, index) => <div className="search-occurrence" key={`${item.line ?? "unknown"}-${index}`}>
      <span className="occurrence-line">{item.line === undefined ? "Indexed match" : `Line ${item.line}${item.endLine !== undefined && item.endLine !== item.line ? `–${item.endLine}` : ""}`}</span>
      {item.snippet ? <CodeViewer text={item.snippet} startLine={item.line}/> : <span className="occurrence-note">Exact occurrence in the indexed source</span>}
      <TechnicalDetails item={item}/>
    </div>)}</div>
  </article>)}</div>;
}

function OutlineResult({ item }: { item: PresentedResult }): React.JSX.Element {
  return <article className="outline-row"><span className={`classification-dot ${item.rawClassification}`}/><div><b>{item.title}</b><small>{item.kind}</small></div>{item.line !== undefined && <span className="outline-line">Line {item.line}</span>}<TechnicalDetails item={item}/></article>;
}

function SourceResult({ item }: { item: PresentedResult }): React.JSX.Element {
  return <article className="source-result"><div className="source-heading"><div><ResultMeta item={item}/><h3>{item.title}</h3><ResultLocation item={item}/></div></div>{item.snippet ? <CodeViewer text={item.snippet} startLine={item.line}/> : <div className="state-card empty-state"><b>Source text was not hydrated</b><span>The indexed location is available, but this response did not include a source snippet.</span></div>}<TechnicalDetails item={item}/></article>;
}

function ReferenceResults({ items }: { items: readonly PresentedResult[] }): React.JSX.Element {
  const paths = new Map<string, PresentedResult[]>();
  for (const item of items) { const key = item.path ?? "Location not reported"; paths.set(key, [...(paths.get(key) ?? []), item]); }
  return <div className="reference-files">{[...paths.entries()].map(([path, entries]) => <section className="reference-file" key={path}><div className="reference-file-heading"><h4>{path}</h4><span>{entries.length} {entries.length === 1 ? "reference" : "references"}</span></div>{entries.map((item, index) => <SearchResult item={item} key={`${item.title}-${item.line ?? index}`}/>)}</section>)}</div>;
}

export function ResultPage({ result, operation = "", loading = false, pageNumber = 1, canPrevious = false, onNext, onPrevious, loadingLabel = "Running query" }: { result: unknown; operation?: string; loading?: boolean; pageNumber?: number; canPrevious?: boolean; onNext?: (cursor: string) => void; onPrevious?: (cursor?: string) => void; loadingLabel?: string }): React.JSX.Element {
  if (loading) return <QueryProgress label={loadingLabel}/>;
  if (result === undefined) return <div className="state-card empty-state"><b>No query yet</b><span>Choose an operation and run it to inspect indexed knowledge.</span></div>;
  const error = errorFromResult(result);
  if (error !== undefined) return <><div className="state-card error-state"><b>Couldn’t run this query</b><span>{error}</span></div><RawInspector value={result}/></>;
  const page = pageFromResult(result);
  const presented = presentResultPage(page, operation);
  const navigation = pageNavigation(page, canPrevious);
  const shownResults = presented.groups.reduce((sum, group) => sum + group.items.length, 0);
  return <div className="result-area"><StatusStrip page={page} hiddenGenerated={presented.hiddenGenerated} shownResults={shownResults} totalResults={navigation.total} pageNumber={pageNumber}/>{presented.groups.length === 0
    ? <div className="state-card empty-state"><b>{presented.hiddenGenerated > 0 ? "Only generated output matched" : "No matching indexed data"}</b><span>{presented.hiddenGenerated > 0 ? "Generated build artifacts remain available in Technical details, but are hidden from the main view." : "Try a broader term or verify that the required index is ready."}</span></div>
    : <div className="result-groups">{presented.groups.map((group) => <section className={`result-group operation-${operation.split(":").at(-1) ?? "results"}`} key={group.id}><div className="result-group-heading"><div><small>Result group</small><h2>{group.label}</h2></div><span>{group.items.length} on this page · {group.total} total</span></div>{operation === "core:get_source"
      ? <div className="source-list">{group.items.map((item, index) => <SourceResult item={item} key={`${item.path}-${item.line ?? index}`}/>)}</div>
      : operation === "core:get_outline"
        ? <div className="outline-list">{group.items.map((item, index) => <OutlineResult item={item} key={`${item.title}-${item.line ?? index}`}/>)}</div>
        : operation === "core:find_references"
          ? <ReferenceResults items={group.items}/>
          : operation === "core:search_text" && group.id === "matches"
            ? <SearchResults items={group.items} exactMatches/>
            : <div className={operation === "core:inspect_architecture" ? "architecture-grid" : "result-list"}>{group.items.map((item, index) => <SearchResult item={item} key={`${item.title}-${item.path}-${item.line ?? index}`}/>)}</div>}</section>)}</div>}
    {(navigation.hasPrevious || navigation.hasNext) && <nav className="result-pagination" aria-label="Result pages"><button className="button secondary" disabled={!navigation.hasPrevious || !onPrevious} onClick={() => onPrevious?.(navigation.previousCursor)}>← Previous page</button><span>Page {pageNumber}<small>{navigation.returned} hydrated items · {navigation.total} total</small></span><button className="button secondary" disabled={!navigation.nextCursor || !onNext} onClick={() => navigation.nextCursor && onNext?.(navigation.nextCursor)}>Next page →</button></nav>}
    <RawInspector value={result}/>
  </div>;
}
