import type { NativeAccelerationMutationTrace } from "./native-acceleration-controller.mjs";

export interface NativeAccelerationMutationTraceGenerationOptions {
  readonly corpusPath: string;
  readonly traceId: string;
  readonly excludedPaths: readonly string[];
}

export interface NativeAccelerationMutationTraceValidation {
  readonly trace_id: string;
  readonly corpus_digest: string;
  readonly mutation_trace_digest: string;
  readonly mutation_count: 60;
  readonly final_corpus_digest: string;
}

export function generateNativeAccelerationMutationTrace(options: NativeAccelerationMutationTraceGenerationOptions): Promise<NativeAccelerationMutationTrace>;
export function writeNativeAccelerationMutationTrace(path: string, trace: NativeAccelerationMutationTrace): Promise<{ readonly path: string; readonly bytes: Uint8Array; readonly mutation_trace_digest: string }>;
export function validatePreparedNativeAccelerationMutationTrace(options: { readonly corpusPath: string; readonly tracePath: string }): Promise<NativeAccelerationMutationTraceValidation>;
export function runPrepareNativeAccelerationTraceCli(argv: readonly string[], io?: { readonly stdout?: Pick<NodeJS.WriteStream, "write"> }): Promise<void>;
