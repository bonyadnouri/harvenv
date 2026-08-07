/**
 * Where harv keeps machine-global state.
 *
 * The Store is the deduplicated pool of fetched artifacts that Harvenvs
 * materialize from; its own slice will give it fetching, content addressing and
 * garbage collection. This module is only the address: one root, overridable,
 * so that the first artifact to need a home — the vendored mise — does not
 * invent a private convention the Store slice then has to migrate off.
 *
 * `HARV_HOME` moves the whole thing, which is what a test, a sandbox, or a CI
 * job with a cold cache wants.
 */

import { homedir } from "node:os";
import { join } from "node:path";

/** The root of everything harv owns on this machine. */
export function harvHome(): string {
  const override = process.env.HARV_HOME;
  return override && override.length > 0 ? override : join(homedir(), ".harv");
}

/** A path inside the Store, which is versioned per artifact rather than shared. */
export const storePath = (...parts: string[]): string => join(harvHome(), "store", ...parts);
