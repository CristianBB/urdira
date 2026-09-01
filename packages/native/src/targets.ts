export type NativeLibc = "glibc" | "unsupported";

export interface NativeTarget {
  readonly id: "darwin-arm64" | "darwin-x64" | "linux-arm64-gnu" | "linux-x64-gnu" | "win32-x64";
  readonly package_name:
    | "@urdira/native-darwin-arm64"
    | "@urdira/native-darwin-x64"
    | "@urdira/native-linux-arm64-gnu"
    | "@urdira/native-linux-x64-gnu"
    | "@urdira/native-win32-x64";
  readonly platform: "darwin" | "linux" | "win32";
  readonly arch: "arm64" | "x64";
  readonly libc?: "glibc";
  readonly triple:
    | "aarch64-apple-darwin"
    | "x86_64-apple-darwin"
    | "aarch64-unknown-linux-gnu"
    | "x86_64-unknown-linux-gnu"
    | "x86_64-pc-windows-msvc";
  readonly artifact_relative_path: string;
}

const target = (
  id: NativeTarget["id"],
  packageName: NativeTarget["package_name"],
  platform: NativeTarget["platform"],
  arch: NativeTarget["arch"],
  triple: NativeTarget["triple"],
  libc?: "glibc",
): NativeTarget => ({
  id,
  package_name: packageName,
  platform,
  arch,
  ...(libc === undefined ? {} : { libc }),
  triple,
  artifact_relative_path: `prebuilds/${triple}/urdira-native.node`,
});

export const SUPPORTED_NATIVE_TARGETS: readonly NativeTarget[] = Object.freeze([
  target("darwin-arm64", "@urdira/native-darwin-arm64", "darwin", "arm64", "aarch64-apple-darwin"),
  target("darwin-x64", "@urdira/native-darwin-x64", "darwin", "x64", "x86_64-apple-darwin"),
  target("linux-arm64-gnu", "@urdira/native-linux-arm64-gnu", "linux", "arm64", "aarch64-unknown-linux-gnu", "glibc"),
  target("linux-x64-gnu", "@urdira/native-linux-x64-gnu", "linux", "x64", "x86_64-unknown-linux-gnu", "glibc"),
  target("win32-x64", "@urdira/native-win32-x64", "win32", "x64", "x86_64-pc-windows-msvc"),
]);

function detectedLibc(platform: string): NativeLibc | undefined {
  if (platform !== "linux") return undefined;
  const report = process.report?.getReport() as Readonly<Record<string, unknown>> | undefined;
  const header = report?.["header"] as Readonly<Record<string, unknown>> | undefined;
  return typeof header?.["glibcVersionRuntime"] === "string" ? "glibc" : "unsupported";
}

export function resolveNativeTarget(
  platform: string = process.platform,
  arch: string = process.arch,
  libc: NativeLibc | undefined = detectedLibc(platform),
): NativeTarget {
  const resolved = SUPPORTED_NATIVE_TARGETS.find((candidate) =>
    candidate.platform === platform
    && candidate.arch === arch
    && (candidate.platform !== "linux" || candidate.libc === libc),
  );
  if (resolved === undefined) {
    const libcSuffix = platform === "linux" ? `/${libc ?? "unknown-libc"}` : "";
    throw new Error(`Unsupported Urdira native target: ${platform}/${arch}${libcSuffix}.`);
  }
  return resolved;
}
