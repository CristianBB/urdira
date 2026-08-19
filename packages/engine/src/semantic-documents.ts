import { canonicalBytes, digestBytes } from "@urdira/canonical";

export interface SemanticDocumentEnrichment {
  readonly section_kind: string;
  readonly text: string;
  readonly source_record_ids?: readonly string[];
}

export interface SemanticDocumentInput {
  readonly artifact_id: string;
  readonly artifact_version_id: string;
  readonly display_path: string;
  readonly content_class: string;
  readonly language_ids: readonly string[];
  readonly source_text: string;
  readonly enrichment?: readonly SemanticDocumentEnrichment[];
  readonly eligibility_status?: "eligible" | "excluded" | "unsupported" | "pending";
}

export interface SemanticDocumentSection {
  readonly section_id: string;
  readonly section_kind: string;
  readonly origin_kind: "generic_source" | "plugin_enrichment";
  readonly text: string;
  readonly source_artifact_version_id: string;
  readonly source_record_ids: readonly string[];
  readonly section_digest: string;
}

export interface SemanticDocument {
  readonly document_id: string;
  readonly artifact_id: string;
  readonly artifact_version_id: string;
  readonly display_path: string;
  readonly content_class: string;
  readonly language_ids: readonly string[];
  readonly source_text: string;
  readonly source_content_digest: string;
  readonly sections: readonly SemanticDocumentSection[];
  readonly semantic_content_digest: string;
  readonly eligibility_status: "eligible" | "excluded" | "unsupported" | "pending";
}

function textDigest(text: string): string { return digestBytes(new TextEncoder().encode(text)); }

function section(value: Omit<SemanticDocumentSection, "section_id" | "section_digest">): SemanticDocumentSection {
  const sectionDigest = digestBytes(canonicalBytes(value));
  return { ...value, section_id: `section:${sectionDigest}`, section_digest: sectionDigest };
}

export function buildSemanticDocument(input: SemanticDocumentInput): SemanticDocument {
  const sourceContentDigest = textDigest(input.source_text);
  const generic = section({
    section_kind: "source",
    origin_kind: "generic_source",
    text: input.source_text,
    source_artifact_version_id: input.artifact_version_id,
    source_record_ids: [],
  });
  const enrichments = [...(input.enrichment ?? [])]
    .filter((value) => value.text.length > 0)
    .map((value) => section({
      section_kind: value.section_kind,
      origin_kind: "plugin_enrichment",
      text: value.text,
      source_artifact_version_id: input.artifact_version_id,
      source_record_ids: [...(value.source_record_ids ?? [])].sort(),
    }))
    .sort((left, right) => left.section_digest.localeCompare(right.section_digest));
  const sections = [generic, ...enrichments];
  const documentId = `document:${digestBytes(canonicalBytes({ artifact_id: input.artifact_id, artifact_version_id: input.artifact_version_id }))}`;
  const semanticContentDigest = digestBytes(canonicalBytes({
    document_id: documentId,
    artifact_id: input.artifact_id,
    artifact_version_id: input.artifact_version_id,
    content_class: input.content_class,
    language_ids: [...input.language_ids].sort(),
    sections,
  }));
  return {
    document_id: documentId,
    artifact_id: input.artifact_id,
    artifact_version_id: input.artifact_version_id,
    display_path: input.display_path,
    content_class: input.content_class,
    language_ids: [...input.language_ids].sort(),
    source_text: input.source_text,
    source_content_digest: sourceContentDigest,
    sections,
    semantic_content_digest: semanticContentDigest,
    eligibility_status: input.eligibility_status ?? "eligible",
  };
}
