import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const digest = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

/** Validate the installed release CLI without starting its daemon or a model. */
export async function validateInstalledUrdiraCli({ cliPath, releaseRoot, expectedSha256, expectedVersion }) {
  if (typeof cliPath !== "string" || !existsSync(cliPath)) throw new Error(`Installed Urdira launcher is missing: ${cliPath}`);
  const cliSha256 = digest(cliPath);
  if (typeof expectedSha256 === "string" && cliSha256 !== expectedSha256) throw new Error(`Installed Urdira launcher does not match the release binding: ${cliPath}`);
  const cliModulePath = join(releaseRoot, "node_modules/@urdira/cli/dist/index.js");
  if (!existsSync(cliModulePath)) throw new Error(`Installed Urdira CLI module is missing: ${cliModulePath}`);
  const cliModule = await import(pathToFileURL(cliModulePath).href);
  if (typeof cliModule.parseCliArgs !== "function") throw new Error("Installed Urdira CLI parser is unavailable");
  const parsed = cliModule.parseCliArgs(["status", "--json"]);
  if (parsed?.name !== "status" || parsed?.options?.json !== true) throw new Error("Installed Urdira CLI status command metadata is invalid");
  return {
    status: "passed",
    command: ["status", "--json"],
    command_name: parsed.name,
    cli_path: cliPath,
    cli_sha256: cliSha256,
    cli_version: expectedVersion ?? null,
    model_invoked: false,
    daemon_started: false,
  };
}
