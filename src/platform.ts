/**
 * The platforms harv ships for, and the vocabulary the release artifacts use.
 *
 * One identifier — `darwin-arm64` — names the same thing everywhere: the key in
 * `vendor/mise.lock.json`, the directory a vendored mise lands in, the suffix
 * of a release tarball, and what `harv --version` prints. It is spelled the way
 * the running process already spells itself (`process.platform`-`process.arch`)
 * so the binary can recognise its own platform without a lookup table.
 *
 * Windows is deferred (issue #13): `bun build --compile` targets it, but the
 * launch recipe and symlink-based materialization (ADR 0008) have not been
 * measured there, so shipping a binary would promise more than harv can keep.
 */

/** Release targets, in the order artifacts and checksums are listed. */
export const PLATFORMS = ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"] as const;

export type Platform = (typeof PLATFORMS)[number];

export const isPlatform = (value: string): value is Platform =>
  (PLATFORMS as readonly string[]).includes(value);

/** What `bun build --compile --target` calls the same platform. */
export const bunTarget = (platform: Platform): string => `bun-${platform}`;

/**
 * The platform this process is running on, whether or not harv ships for it.
 * Returned unvalidated so callers can report an unsupported host by name
 * instead of failing with a generic "unknown platform".
 */
export const currentPlatform = (): string => `${process.platform}-${process.arch}`;
