/**
 * `harv add`: turning a coordinate into a Manifest entry.
 *
 * The Manifest is edited as *text*, not parsed and re-serialized. It is a file
 * a person wrote and keeps writing — comments, ordering, spacing and all — and
 * a round-trip through a TOML serializer would silently reformat every line of
 * it the first time harv touched it. So the new entry is inserted into the
 * `[skills]` table and nothing else moves. Where that cannot be done safely,
 * harv says so instead of guessing.
 */

import { COMPONENT_NAME_RULE, isComponentName } from "./manifest.ts";
import type { MarketplaceSource, Source } from "./manifest.ts";

export class AddError extends Error {
  override name = "AddError";
}

/**
 * A git coordinate as one string: `<repo>[@<ref>][#<subdir>]`.
 *
 * `#` is unambiguous. `@` is not — `git@github.com:owner/repo.git` opens with
 * one — so it only separates a ref when it comes after the last `/`, which is
 * true of `…/repo.git@v1` and false of every SSH user@host.
 */
export function parseCoordinate(coordinate: string): { repo: string; ref?: string; subdir?: string } {
  const hash = coordinate.indexOf("#");
  const subdir = hash === -1 ? undefined : coordinate.slice(hash + 1);
  const withoutSubdir = hash === -1 ? coordinate : coordinate.slice(0, hash);

  const at = withoutSubdir.lastIndexOf("@");
  const separates = at > withoutSubdir.lastIndexOf("/");

  return {
    repo: separates ? withoutSubdir.slice(0, at) : withoutSubdir,
    ...(separates ? { ref: withoutSubdir.slice(at + 1) } : {}),
    ...(subdir !== undefined && subdir !== "" ? { subdir } : {}),
  };
}

/** The table an added Source belongs in — which is decided by what it is. */
export const tableFor = (source: Source | MarketplaceSource): string =>
  source.kind === "marketplace" ? "plugins" : "skills";

/** The line a Source becomes in its table. */
export function entryLine(name: string, source: Source | MarketplaceSource): string {
  const fields =
    source.kind === "path"
      ? [`path = ${quote(source.declared)}`]
      : [
          `${source.kind === "marketplace" ? "marketplace" : "git"} = ${quote(source.repo)}`,
          ...(source.ref === undefined ? [] : [`ref = ${quote(source.ref)}`]),
          ...(source.kind === "git" && source.subdir !== undefined ? [`subdir = ${quote(source.subdir)}`] : []),
        ];
  return `${quoteKey(name)} = { ${fields.join(", ")} }`;
}

/**
 * The Manifest text with `line` added to its `[<table>]` table.
 *
 * The table runs from its header to the next table header or the end of the
 * file, and the entry lands after its last non-blank line — so repeated adds
 * accumulate in order rather than pushing each other apart.
 */
export function withEntry(text: string, line: string, table = "skills"): string {
  const lines = text.split("\n");
  const header = lines.findIndex((entry) => new RegExp(`^\\s*\\[${table}\\]\\s*(#.*)?$`).test(entry));

  if (header === -1) {
    if (new RegExp(`^\\s*${table}\\s*=`, "m").test(text)) {
      throw new AddError(
        `this Manifest writes \`${table}\` as an inline table, which harv will not rewrite safely. ` +
          "Add the entry by hand, then run `harv sync`.",
      );
    }
    const separator = text === "" || text.endsWith("\n\n") ? "" : text.endsWith("\n") ? "\n" : "\n\n";
    return `${text}${separator}[${table}]\n${line}\n`;
  }

  let end = header + 1;
  while (end < lines.length && !/^\s*\[/.test(lines[end] ?? "")) end += 1;
  // Back over the blank lines that separate this table from the next one, so
  // the entry joins the table rather than the gap after it.
  let insert = end;
  while (insert > header + 1 && (lines[insert - 1] ?? "").trim() === "") insert -= 1;

  lines.splice(insert, 0, line);
  return lines.join("\n");
}

/** Everything `harv add` needs to know before it touches the Manifest. */
export function validateName(name: string | undefined): string {
  if (name === undefined || name.startsWith("-")) {
    throw new AddError("`harv add` needs a name: `harv add <name> --git <coordinate>`");
  }
  if (!isComponentName(name)) {
    throw new AddError(
      `\`${name}\` is not a usable Component name: ${COMPONENT_NAME_RULE}. ` +
        `The name is also the name the session answers to (ADR 0008).`,
    );
  }
  return name;
}

/** TOML basic strings, which is all a repository URL or path ever needs. */
const quote = (value: string): string => JSON.stringify(value);

/** Bare keys cover every name harv accepts, but a leading digit reads better quoted. */
const quoteKey = (name: string): string => (/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(name) ? name : quote(name));
