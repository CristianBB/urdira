import { readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Test and benchmark fixtures deliberately live below the host temporary
 * directory, but a killed Vitest process cannot run a fixture's `finally`
 * block.  Those abandoned roots are especially expensive for the index-pack
 * scale tests, which can contain gigabytes of SQLite/CAS data.  Keep the
 * cleanup at the test-run boundary so interrupted runs do not poison the next
 * one (or eventually exhaust the volume).
 *
 * Only project-scoped temporary names are considered.  User-managed model and
 * interactive-agent caches are intentionally left alone.
 */
const isProjectTemporary = (name: string): boolean => name.startsWith("urdira-")
  && !name.startsWith("urdira-models")
  && !name.startsWith("urdira-interactive-agent");

async function cleanupProjectTemporaries(): Promise<void> {
  const root = tmpdir();
  const entries = await readdir(root, { withFileTypes: true });
  await Promise.all(entries
    .filter((entry) => isProjectTemporary(entry.name))
    .map((entry) => rm(join(root, entry.name), { recursive: true, force: true })));
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  await cleanupProjectTemporaries();
  return cleanupProjectTemporaries;
}
