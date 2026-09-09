# Semantic Model Provisioning

Status: **Accepted** (2026-08-13 — replaces a preinstalled, release-bundled data-only model pack, which was **Rejected** the same day: acceptance required always downloading at explicit configure time with a visible download notice, which a bundled pack cannot provide; the contract below is what shipped instead)
Last updated: 2026-09-09
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
policies. Normal daemon and query paths never acquire model assets.
With the default local provider they operate offline.

An HTTP embedding provider is a separate explicit runtime choice. Selecting it
does not relax the local provider's configure-time-only acquisition rule and
its results use a distinct provider identity. In HTTP mode, semantic
maintenance sends document segments and semantic queries send query text to
the configured endpoint; this is distinct from downloading model assets.

## Current boundary

There is no distributed semantic model-pack artifact, automatic model
selection harness, or implicit model upgrade. Introducing any of those changes
requires updating this current contract and the release/package acceptance
rules in the same change.

## Change history

- **2026-08-13**: rejected a release-bundled, preinstalled data-only model pack in favor of the always-download-at-configure contract documented above, with a visible "downloading" notice in the configuration response. `docs/decisions/06-semantic-search-ranking.md`'s "Release-bound semantic registries" section was updated to stop requiring a preinstalled pack.
