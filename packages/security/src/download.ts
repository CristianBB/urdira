import { digestBytes } from "@urdira/canonical";
import { SecurityError } from "./errors.js";

export interface DownloadResponse { readonly status: number; readonly headers: Readonly<Record<string, string>>; readonly body: Uint8Array; readonly final_locator?: string; readonly redirect_hops?: number; readonly compressed_byte_length?: number; }
export interface DownloadTransport { fetch(locator: string, options: { readonly signal?: AbortSignal; readonly max_bytes: number }): Promise<DownloadResponse>; }
export interface DownloadLimits { readonly max_total_bytes?: number; readonly max_time_ms?: number; readonly max_decompression_ratio?: number; readonly max_redirect_hops?: number; readonly max_concurrency?: number; }
export interface DownloadRequest { readonly authorized_manifest_digest: string; readonly manifest_locator: string; readonly blob_locators: Readonly<Record<string, string>>; readonly allow_redirects?: boolean; readonly max_bytes?: number; readonly signal?: AbortSignal; readonly limits?: DownloadLimits; readonly clock?: () => number; readonly cleanup?: () => Promise<void>; }
export interface DownloadedModelPack { readonly manifest: Uint8Array; readonly blobs: ReadonlyMap<string, Uint8Array>; }

function validateLocator(locator: string): URL {
  let parsed: URL;
  try { parsed = new URL(locator); } catch { throw new SecurityError("security:download_scheme_forbidden", "Model-pack locator is not a valid URL."); }
  if (parsed.username || parsed.password || !["https:", "file:"].includes(parsed.protocol)) throw new SecurityError("security:download_scheme_forbidden", "Only explicit HTTPS or file model-pack locators are allowed.");
  return parsed;
}

function redirectAllowed(response: DownloadResponse, requestLocator: URL, allowRedirects: boolean, maxRedirectHops: number): void {
  const statusRedirect = [301, 302, 303, 307, 308].includes(response.status);
  const reportedRedirect = response.final_locator !== undefined && response.final_locator !== requestLocator.href;
  if (!statusRedirect && !reportedRedirect) return;
  if (!allowRedirects || !response.final_locator) throw new SecurityError("security:download_redirect_forbidden", "Redirects are disabled for model-pack downloads.");
  if ((response.redirect_hops ?? 1) > maxRedirectHops) throw new SecurityError("security:download_redirect_forbidden", "Model-pack redirect hop limit exceeded.");
  let target: URL;
  try { target = validateLocator(response.final_locator); } catch { throw new SecurityError("security:download_redirect_forbidden", "Redirect target is not an allowed HTTPS locator."); }
  if (target.protocol !== "https:" || target.origin !== requestLocator.origin) throw new SecurityError("security:download_redirect_forbidden", "Redirect must remain HTTPS and same-origin.");
}

interface DownloadContext {
  readonly controller: AbortController;
  readonly startedAt: number;
  readonly maxTotalBytes: number;
  totalBytes: number;
  reservedBytes: number;
}

function reserveBytes(context: DownloadContext, requested: number): number {
  const remaining = context.maxTotalBytes - context.totalBytes - context.reservedBytes;
  if (remaining <= 0) throw new SecurityError("security:download_limit_exceeded", "Model-pack total byte limit exceeded.");
  const allowance = Math.min(requested, remaining);
  context.reservedBytes += allowance;
  return allowance;
}

async function fetchChecked(transport: DownloadTransport, locator: string, request: DownloadRequest, context: DownloadContext): Promise<{ readonly bytes: Uint8Array; readonly compressedBytes: number }> {
  if (request.signal?.aborted || context.controller.signal.aborted) throw new SecurityError("security:download_cancelled", "Model-pack download was cancelled.");
  const parsed = validateLocator(locator);
  const timeoutMs = request.limits?.max_time_ms;
  const elapsed = (request.clock ?? Date.now)() - context.startedAt;
  const remaining = timeoutMs === undefined ? undefined : timeoutMs - elapsed;
  if (remaining !== undefined && remaining <= 0) throw new SecurityError("security:download_time_exceeded", "Model-pack download time limit exceeded.");
  const requestedBytes = request.max_bytes ?? 256 * 1024 * 1024;
  const allowance = reserveBytes(context, requestedBytes);
  let committed = false;
  try {
    const fetchPromise = transport.fetch(locator, { signal: context.controller.signal, max_bytes: allowance });
    void fetchPromise.catch(() => undefined);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let removeCancellation: (() => void) | undefined;
    const timeoutPromise = remaining === undefined ? undefined : new Promise<DownloadResponse>((_, reject) => {
      timer = setTimeout(() => { reject(new SecurityError("security:download_time_exceeded", "Model-pack download time limit exceeded.")); context.controller.abort(); }, remaining);
    });
    const cancellationPromise = request.signal === undefined ? undefined : new Promise<DownloadResponse>((_, reject) => {
      const cancel = (): void => { reject(new SecurityError("security:download_cancelled", "Model-pack download was cancelled.")); context.controller.abort(); };
      request.signal?.addEventListener("abort", cancel, { once: true });
      removeCancellation = () => request.signal?.removeEventListener("abort", cancel);
    });
    let response: DownloadResponse;
    try {
      response = await Promise.race([fetchPromise, ...(timeoutPromise ? [timeoutPromise] : []), ...(cancellationPromise ? [cancellationPromise] : [])]);
    } finally {
      if (timer) clearTimeout(timer);
      removeCancellation?.();
    }
    if (request.signal?.aborted) throw new SecurityError("security:download_cancelled", "Model-pack download was cancelled.");
    redirectAllowed(response, parsed, request.allow_redirects === true, request.limits?.max_redirect_hops ?? 5);
    if (response.status < 200 || response.status >= 300) throw new SecurityError("security:download_limit_exceeded", `Model-pack download returned status ${response.status}.`);
    if (response.body.byteLength > allowance) throw new SecurityError("security:download_limit_exceeded", "Model-pack download exceeds the aggregate byte allowance.");
    context.reservedBytes -= allowance;
    context.totalBytes += response.body.byteLength;
    committed = true;
    return { bytes: new Uint8Array(response.body), compressedBytes: response.compressed_byte_length ?? response.body.byteLength };
  } catch (error) {
    if (!committed) context.reservedBytes -= allowance;
    throw error;
  }
}

export class AdministrativeModelPackDownloader {
  constructor(private readonly transport: DownloadTransport) {}

  async download(request: DownloadRequest): Promise<DownloadedModelPack> {
    if (request.limits?.max_concurrency !== undefined && request.limits.max_concurrency < 1) throw new SecurityError("security:download_concurrency_exceeded", "Model-pack download concurrency must be positive.");
    const clock = request.clock ?? Date.now;
    const startedAt = clock();
    const controller = new AbortController();
    const context: DownloadContext = { controller, startedAt, maxTotalBytes: request.limits?.max_total_bytes ?? Number.POSITIVE_INFINITY, totalBytes: 0, reservedBytes: 0 };
    let compressedBytes = 0;
    const checkLimits = (): void => {
      if (request.signal?.aborted) throw new SecurityError("security:download_cancelled", "Model-pack download was cancelled.");
      if (request.limits?.max_time_ms !== undefined && clock() - startedAt > request.limits.max_time_ms) throw new SecurityError("security:download_time_exceeded", "Model-pack download time limit exceeded.");
      if (request.limits?.max_total_bytes !== undefined && context.totalBytes > request.limits.max_total_bytes) throw new SecurityError("security:download_limit_exceeded", "Model-pack total byte limit exceeded.");
      if (request.limits?.max_decompression_ratio !== undefined && compressedBytes > 0 && context.totalBytes / compressedBytes > request.limits.max_decompression_ratio) throw new SecurityError("security:download_limit_exceeded", "Model-pack decompression ratio limit exceeded.");
    };
    try {
      checkLimits();
      const manifestResponse = await fetchChecked(this.transport, request.manifest_locator, request, context);
      const manifest = manifestResponse.bytes;
      compressedBytes += manifestResponse.compressedBytes;
      checkLimits();
      if (digestBytes(manifest) !== request.authorized_manifest_digest) throw new SecurityError("security:download_digest_mismatch", "Downloaded manifest does not match the authorized digest.");
      const blobs = new Map<string, Uint8Array>();
      const entries = Object.entries(request.blob_locators);
      const maxConcurrency = Math.min(request.limits?.max_concurrency ?? 1, Math.max(entries.length, 1));
      let next = 0;
      const worker = async (): Promise<void> => {
        while (true) {
          const index = next++;
          const entry = entries[index];
          if (!entry) return;
          const [expectedDigest, locator] = entry;
          const response = await fetchChecked(this.transport, locator, request, context);
          compressedBytes += response.compressedBytes;
          checkLimits();
          if (digestBytes(response.bytes) !== expectedDigest) throw new SecurityError("security:download_digest_mismatch", `Downloaded blob does not match ${expectedDigest}.`);
          blobs.set(expectedDigest, response.bytes);
        }
      };
      await Promise.all(Array.from({ length: maxConcurrency }, () => worker()));
      checkLimits();
      return { manifest, blobs };
    } catch (error) {
      controller.abort();
      await request.cleanup?.();
      throw error;
    }
  }
}
