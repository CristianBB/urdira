# Evaluated Semantic Model Pack

Status: **Rejected** (owner decision 2026-08-13)
Last updated: 2026-08-13

## Outcome (owner decision, 2026-08-13)

The owner rejected the preinstalled pack: model weights are never shipped with a
release. The model is ALWAYS obtained by download -- decision 16's configure-time
download is the permanent flow. One requirement was added in its place: when a
configure RPC needs a model that is not yet present in the local cache, the user
must be clearly informed that the model is being downloaded (progress/notice in the
RPC response path), instead of the download happening silently. The evaluation
harness proposed below was not approved either; if a model swap is ever considered,
re-propose the harness as its own decision. The rest of this document is retained
as the rejected draft.
Depends on: [Semantic search and ranking](06-semantic-search-ranking.md), [Semantic search wiring](16-semantic-search-wiring.md)

## Decision objective

Ship decision 06's endgame: a PREINSTALLED, data-only model pack selected by
reproducible evaluation, so semantic search works fully offline from first install
-- no configure-time download, no runtime dependency on the Hugging Face Hub -- and
model upgrades are gated by measured retrieval quality instead of taste.

## Context

Decision 16's shipped flow downloads the open model (`Xenova/all-MiniLM-L6-v2`, q8,
~23MB) at configure time into `<data_root>/models`, and runs strictly offline
everywhere else. That already isolates the network to one admin RPC; what remains
for decision 06's full vision is (a) removing the download entirely by shipping
weights with the release, and (b) an evaluation harness that justifies the choice
of model and gates any future swap.

## Proposed decision

- **Pack format (data-only).** A release artifact `urdira-model-pack-<profile>.tar`
  containing: ONNX weights + tokenizer files exactly as transformers.js resolves
  them from a cache dir, and a `pack-manifest.json` with {format_version, model_id,
  dtype, dimensions, per-file sha256 digests, resulting embedding_profile_id +
  executable_binding_digest}. Installing a pack = verifying every digest and placing
  files into the model cache layout `ensureLocalEmbeddingModel` already reads --
  after which the existing offline construction path (`allow_download: false`) just
  works, byte-identical to a configure-time download of the same model. No code in
  the daemon changes behavior based on HOW the cache got populated.
- **Distribution.** The pack is NOT part of the npm package (23MB+ per dtype;
  release-contract lockstep lists stay code-only). It is a sibling release artifact
  produced by `scripts/package-release.mjs`, installed by
  `urdira model-pack install <tar>` (new CLI admin command that verifies digests and
  populates the cache) or unpacked by an operator. Configure-time download remains
  the fallback when no pack is installed -- the two flows converge on the same
  cache bytes.
- **Evaluation harness (the gate).** A repo-local retrieval benchmark
  (`scripts/semantic-eval.mjs` + `tests/fixtures/semantic-eval/`): a frozen set of
  (query, expected-artifact/entity) judgments over 2-3 pinned open-source corpora
  (excalidraw-scale and small), scoring nDCG@10 / recall@10 through the REAL
  reconciler + query port with the candidate provider. `selectBundledProfile`
  (`packages/engine/src/semantic-selection.ts`, currently unimplemented per
  decision 16) becomes the recorded output of this harness: a model swap PR must
  include the harness run showing the new pack meets or beats the incumbent on the
  frozen judgment set. The harness is a script, not a CI test -- it needs real
  inference and minutes of wall clock; CI keeps the hermetic hash provider.
- **Identity discipline (unchanged).** A pack is just a provider identity: new
  model/dtype => new `embedding_profile_id`/`executable_binding_digest` => the
  reconciler's profile-swap-close machinery re-embeds workspaces safely (decision
  16). Nothing about pack installation mutates an existing identity.

## Open questions for the owner

1. Which corpora + judgment sets to freeze for the harness (hand-authored judgments
   are a few hours of curation; synthetic judgments from code structure are cheaper
   but weaker).
2. Whether the default release should bundle the pack tar alongside binaries in the
   release archive (bigger download for everyone) or keep it a separate download
   (today's configure-time flow stays the default for most installs).
3. Whether q8 remains the shipped dtype or the pack ships fp32 + q8 variants.

## Explicitly out of scope

Changing the default model before the harness exists; ANN indexing; any
online/telemetry-based evaluation.
