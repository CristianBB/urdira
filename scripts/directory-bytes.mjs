import { stat } from "node:fs/promises";
import { join } from "node:path";

export async function directoryBytes(root, relativePaths, statPath = stat) {
  let total = 0;
  for (const path of relativePaths) {
    try {
      total += (await statPath(join(root, ...path.split("/")))).size;
    } catch (error) {
      // CAS writes use atomic rename from data/cas/.tmp. A completed rename can
      // remove a temporary entry between enumeration and stat; it consumes no
      // final disk and must not invalidate an otherwise complete benchmark.
      if (error?.code !== "ENOENT") throw error;
    }
  }
  return total;
}
