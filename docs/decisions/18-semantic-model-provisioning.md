# Semantic Model Provisioning

Status: **Approved and implemented**
Last updated: 2026-08-24
Depends on: [Semantic search and ranking](06-semantic-search-ranking.md) and [semantic runtime](16-semantic-search-wiring.md)

## Current contract

Urdira releases do not bundle model weights, tokenizers, or a preinstalled
model pack. The default local model is
`Xenova/all-MiniLM-L6-v2`, acquired into `<data_root>/models` only through an
explicit configuration operation.

The configuration response reports whether assets were already present or are
being downloaded. A model download is never triggered by daemon startup,
workspace scanning, semantic maintenance, a query, cursor continuation, or
replay.

After acquisition, runtime construction uses the local cache with network
access disabled. Missing or invalid assets leave semantic capabilities
unavailable while source and structural capabilities continue normally.

## Integrity and identity

The resolved semantic provider pins the model identifier, runtime build,
dimensions, dtype, rendering/window policy, and configuration digest. Those
values determine the embedding profile and executable binding identity used by
materializations and queries.

Changing any output-affecting provider coordinate creates a new identity and
requires semantic reconciliation. Existing vectors are never interpreted
under the new provider or converted between vector spaces.

Downloaded assets remain inside the daemon-owned model cache. They are not
embedded in workspace SQLite files, index packs, MCP responses, npm packages,
or release archives.

## Network boundary

Only the explicit administrative provisioning path may perform HTTPS asset
acquisition. It applies configured host, redirect, byte, digest, and storage
policies. Normal daemon and query paths remain offline.

An HTTP embedding provider is a separate explicit runtime choice. Selecting it
does not relax the local provider's configure-time-only acquisition rule and
its results use a distinct provider identity.

## Current boundary

There is no distributed semantic model-pack artifact, automatic model
selection harness, or implicit model upgrade. Introducing any of those changes
requires updating this current contract and the release/package acceptance
rules in the same change.
