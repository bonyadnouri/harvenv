/**
 * The import wizard: `harv init --import`.
 *
 * Every harvenv project after the first one starts from a Manifest somebody
 * wrote. The first one starts from a machine — months of `/plugin install`, a
 * `~/.claude/skills` nobody has pruned since spring, MCP servers whose tokens
 * are in a file the owner has never opened. Declaring that by hand is the
 * migration nobody performs, so the tool that needs it performs it: the wizard
 * reads the pile (`inventory.ts`), groups it, and asks one question per group.
 *
 * ## Three destinations, and the split is the whole point
 *
 * The Manifest is the team baseline and it is committed; the global Overlay is
 * personal and is not (ADR 0002). Which of the two an item belongs in is a
 * judgement only its owner can make — `superpowers` is a team decision, a
 * statusline skill is not — so the wizard's job is to *ask* well rather than to
 * classify. Every kind of item is offered both, plugins included: a plugin pin
 * is as ordinary a personal staple as a skill, and an Overlay resolves and locks
 * one exactly as a Manifest does (ADR 0013). What the wizard does decide,
 * because these are not judgements:
 *
 *   - A local-only skill routed to the Manifest is flagged, with the push it
 *     needs spelled out. ADR 0004 allows a `path` Source and calls it
 *     non-portable; this is the moment somebody can still do something about it.
 *   - A credential in a server definition is not copied into a committed file.
 *     `~/.claude.json` holds tokens in the clear, a Manifest goes to a git
 *     remote, and the seam between them already exists: `${VAR}`, resolved at
 *     launch and never written down (see `mcp.ts`).
 *
 * ## Re-running is a no-op
 *
 * The wizard offers only what nothing declares yet, so a second run over an
 * imported machine asks nothing and writes nothing. That is not a convenience:
 * an import is the one command whose input — the user scope — keeps changing
 * underneath it, so "run it again after installing something" has to be the
 * obvious move rather than a way to end up with two of everything.
 *
 * ## It reads the user scope and writes elsewhere
 *
 * Nothing here writes to `~/.claude`. Adopting harvenv leaves the machine it
 * was adopted on exactly as it was, which is what makes the decision reversible
 * and the wizard safe to try.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { stringify as toToml } from "smol-toml";

import { entryLine, tableFor, withEntry } from "./add.ts";
import { inventory } from "./inventory.ts";
import type { Inventory, InventoryItem } from "./inventory.ts";
import { MANIFEST_FILENAME } from "./manifest.ts";
import type { MarketplaceSource, Source } from "./manifest.ts";
import { GLOBAL_OVERLAY_FILENAME, globalOverlayPath, OVERLAY_FILENAME } from "./overlay.ts";
import type { Env } from "./store.ts";

/** Where one item is sent. `skip` leaves it in the user scope, untouched. */
export type Destination = "manifest" | "overlay" | "skip";

export interface ImportDeps {
  /** The project being imported into. Its Manifest is written in place. */
  root: string;
  env: Env;
  /** Ask one question; resolve to whatever was typed. */
  ask: (question: string) => Promise<string>;
  /** One line of wizard output. */
  say: (line: string) => void;
}

export interface Assignment {
  item: InventoryItem;
  destination: "manifest" | "overlay";
}

export interface ImportResult {
  assigned: Assignment[];
  skipped: InventoryItem[];
  /** Offered to nobody, because something already declares the name. */
  alreadyDeclared: InventoryItem[];
  /** Declared in the Manifest and not portable — ADR 0004's flag, by name. */
  flagged: InventoryItem[];
  /** Paths written, project-relative where they are in the project. */
  written: string[];
  /**
   * What the *scan* could not read, said before the first question — because it
   * is the reason something the user expected to be offered is missing.
   */
  warnings: string[];
  /**
   * What the *writing* discovered, said after the last one — a credential that
   * had to become a `${VAR}`, and the export it now needs.
   */
  notes: string[];
}

/**
 * The heading the global staples file is created with, when the wizard is what
 * creates it. A file harv wrote should say what it is to the person who finds
 * it later and has forgotten.
 */
const OVERLAY_HEADER =
  `# ${GLOBAL_OVERLAY_FILENAME} — your Overlay staples: the personal Components every\n` +
  `# harvenv project on this machine loads on top of its Manifest (ADR 0002).\n` +
  `# Uncommitted and yours alone. \`${OVERLAY_FILENAME}\` in a project overrides it there.\n\n`;

export async function runImport(deps: ImportDeps): Promise<ImportResult> {
  const found = inventory(deps.root, deps.env);
  const result: ImportResult = {
    assigned: [],
    skipped: [],
    alreadyDeclared: found.items.filter((item) => item.declared !== null),
    flagged: [],
    written: [],
    warnings: found.warnings,
    notes: [],
  };

  announce(found, result, deps);

  const offered = found.items.filter((item) => item.declared === null);
  if (offered.length === 0) return finish(result, deps);

  for (const [group, items] of byGroup(offered)) {
    deps.say("");
    deps.say(`  ${group}  (${items.length})`);
    const width = column(items);
    for (const item of items) deps.say(`    ${pad(item.name, width)}  ${item.detail}`);

    const caveat = items.find((item) => item.local !== null)?.local;
    if (caveat !== undefined) deps.say(`    ${DIM}note: ${caveat}${RESET}`);

    for (const [item, destination] of await choose(items, deps)) {
      if (destination === "skip") result.skipped.push(item);
      else result.assigned.push({ item, destination });
    }
  }

  apply(result, deps);
  return finish(result, deps);
}

// ---------------------------------------------------------------------------
// Asking
// ---------------------------------------------------------------------------

/** The answers a question takes, and what each one means. */
const ANSWERS: Record<string, Destination | "choose"> = {
  m: "manifest",
  manifest: "manifest",
  o: "overlay",
  overlay: "overlay",
  s: "skip",
  skip: "skip",
  c: "choose",
  choose: "choose",
};

/**
 * One group's worth of decisions.
 *
 * A group is answered at once by default because the alternative — 68 questions
 * for 68 skills — is a wizard people abandon halfway, leaving a half-declared
 * project. `c` is there for when the group really does need splitting.
 */
async function choose(items: InventoryItem[], deps: ImportDeps): Promise<Array<[InventoryItem, Destination]>> {
  const answer = await question(`  Where do these go?`, true, deps);

  if (answer !== "choose") return items.map((item) => [item, answer]);
  const chosen: Array<[InventoryItem, Destination]> = [];
  for (const item of items) {
    chosen.push([item, (await question(`    ${item.name}`, false, deps)) as Destination]);
  }
  return chosen;
}

/**
 * Ask until the answer is one harv understands.
 *
 * An empty answer is `skip`, not a re-prompt: it is what a piped stdin runs out
 * of, and a wizard that writes files should treat "no answer" as "write
 * nothing". Anything else unrecognised is asked again — a typo'd `mm` is
 * somebody meaning `m`, and guessing on their behalf writes to a committed file.
 */
async function question(prefix: string, offerChoose: boolean, deps: ImportDeps): Promise<Destination | "choose"> {
  const options = [
    "[m]anifest (committed, the team baseline)",
    "[o]verlay (personal, every project)",
    "[s]kip",
    ...(offerChoose ? ["[c]hoose one by one"] : []),
  ];
  const prompt = `${prefix}  ${options.join("  ")} > `;

  for (;;) {
    const typed = (await deps.ask(prompt)).trim();
    const raw = typed.toLowerCase();
    if (raw === "") return "skip";

    const answer = ANSWERS[raw];
    if (answer !== undefined && !(answer === "choose" && !offerChoose)) return answer;

    // Echoed back, because the question is about to be repeated verbatim and a
    // wizard that reprints itself without saying why reads as a broken prompt.
    deps.say(`    harv did not understand \`${typed}\`. Answer with one of the letters below.`);
  }
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/**
 * Every assignment, written into the file it was assigned to.
 *
 * Both files are edited as text for the reason `harv add` is: they are files
 * people wrote and keep writing, and a round-trip through a TOML serializer
 * would reformat every line of one the first time harv touched it.
 */
function apply(result: ImportResult, deps: ImportDeps): void {
  const targets: Array<["manifest" | "overlay", string]> = [
    ["manifest", join(deps.root, MANIFEST_FILENAME)],
    ["overlay", globalOverlayPath(deps.env)],
  ];

  for (const [destination, path] of targets) {
    const assigned = result.assigned.filter((entry) => entry.destination === destination);
    if (assigned.length === 0) continue;

    const before = read(path) ?? (destination === "overlay" ? OVERLAY_HEADER : "");
    let text = before;

    for (const { item } of assigned) {
      // Belt as well as braces: the offer already excluded declared names, and
      // this is what makes a duplicate impossible rather than merely unlikely.
      if (declares(text, item)) continue;
      text = item.kind === "mcp" ? withServer(text, item, destination, result) : withComponent(text, item);
      if (destination === "manifest" && item.local !== null) result.flagged.push(item);
    }

    if (text === before && existsSync(path)) continue;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
    result.written.push(path);
  }
}

/** A skill or a plugin, as the line its table carries. */
function withComponent(text: string, item: InventoryItem): string {
  const source: Source | MarketplaceSource = item.source ?? { kind: "path", declared: item.detail, path: item.detail };
  return withEntry(text, entryLine(item.name, source), tableFor(source));
}

/**
 * An MCP server, as its own `[mcp.<name>]` section appended to the file.
 *
 * Appended rather than inserted: a table header ends whatever table preceded
 * it, so the end of the file is the one position that is always correct
 * regardless of what the last table was.
 */
function withServer(
  text: string,
  item: InventoryItem,
  destination: "manifest" | "overlay",
  result: ImportResult,
): string {
  const definition = destination === "manifest" ? withoutSecrets(item, result) : (item.definition ?? {});
  const section = toToml({ mcp: { [item.name]: definition } });
  return `${text}${text === "" || text.endsWith("\n\n") ? "" : text.endsWith("\n") ? "\n" : "\n\n"}${section}`;
}

/**
 * Whether this file already speaks for the name — in the table the entry would
 * go in, and nowhere else.
 *
 * Scoped to the table because a name is only taken within one: `[settings]` may
 * perfectly well set `model` while `[skills]` has no skill called `model`, and
 * a search of the whole file would read the first as the second and quietly
 * decline to write the entry it had just told the user it was writing.
 */
function declares(text: string, item: InventoryItem): boolean {
  const name = escape(item.name);
  if (item.kind === "mcp") return new RegExp(`^\\s*\\[mcp\\.${name}]`, "m").test(text);
  return new RegExp(`^\\s*"?${name}"?\\s*=`, "m").test(tableBody(text, item.kind === "plugin" ? "plugins" : "skills"));
}

/**
 * One table's lines: from its header to the next header, or "" if the file has
 * no such table — in which case nothing in it is declared.
 */
function tableBody(text: string, table: string): string {
  const lines = text.split("\n");
  const header = lines.findIndex((line) => new RegExp(`^\\s*\\[${table}]\\s*(#.*)?$`).test(line));
  if (header === -1) return "";
  let end = header + 1;
  while (end < lines.length && !/^\s*\[/.test(lines[end] ?? "")) end += 1;
  return lines.slice(header + 1, end).join("\n");
}

const escape = (value: string): string => value.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&");

// ---------------------------------------------------------------------------
// Credentials
// ---------------------------------------------------------------------------

/**
 * Keys whose value is a credential often enough that copying one into a
 * committed file is not a risk worth taking.
 *
 * Deliberately generous. A false positive costs one `export` line, which the
 * summary spells out; a false negative commits somebody's API key to a git
 * remote, which is not recoverable by editing the file afterwards.
 */
const CREDENTIAL_KEY = /token|secret|password|passwd|credential|auth|api[-_ ]?key|^key$|^bearer$/i;

/** Already a reference — the definition was written for this in the first place. */
const REFERENCE = /^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/;

/**
 * The definition with its credential-shaped values replaced by `${VAR}`.
 *
 * Only `env` and `headers` are searched, because those are the two tables that
 * carry secrets in practice and a URL or a command is a thing a Manifest is
 * *for* saying out loud.
 */
function withoutSecrets(item: InventoryItem, result: ImportResult): Record<string, unknown> {
  const definition = { ...(item.definition ?? {}) };

  for (const table of ["env", "headers"]) {
    const values = definition[table];
    if (typeof values !== "object" || values === null || Array.isArray(values)) continue;

    const rewritten: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(values as Record<string, unknown>)) {
      const secret = typeof value === "string" && value !== "" && !REFERENCE.test(value) && CREDENTIAL_KEY.test(key);
      if (!secret) {
        rewritten[key] = value;
        continue;
      }
      const variable = variableName(item.name, key);
      rewritten[key] = `\${${variable}}`;
      result.notes.push(
        `\`[mcp.${item.name}] ${table}.${key}\` held a value that looks like a credential, and a Manifest is ` +
          `committed — so it was declared as \${${variable}} instead. Run \`export ${variable}=…\` with the value ` +
          `from your own configuration before \`harv claude\`; harv resolves it at launch and never stores it.`,
      );
    }
    definition[table] = rewritten;
  }
  return definition;
}

const variableName = (server: string, key: string): string =>
  `${server}_${key}`.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");

// ---------------------------------------------------------------------------
// Saying what happened
// ---------------------------------------------------------------------------

const DIM = "\x1b[2m";
const RESET = "\x1b[0m";

/** The name column, widened to whatever is in this list. */
const column = (items: InventoryItem[]): number => Math.max(16, ...items.map((item) => item.name.length));

const pad = (name: string, width: number): string => name.padEnd(width);

/** Items in the order the groups were built, without re-sorting them. */
function byGroup(items: InventoryItem[]): Array<[string, InventoryItem[]]> {
  const groups = new Map<string, InventoryItem[]>();
  for (const item of items) groups.set(item.group, [...(groups.get(item.group) ?? []), item]);
  return [...groups];
}

function announce(found: Inventory, result: ImportResult, deps: ImportDeps): void {
  for (const warning of found.warnings) deps.say(`  warning: ${warning}`);

  if (!found.scope.exists) {
    deps.say(`No user scope to import from: ${found.scope.dir} does not exist.`);
    return;
  }

  const offered = found.items.length - result.alreadyDeclared.length;
  deps.say(
    offered === 0
      ? `Nothing left to import from ${found.scope.dir}.`
      : `Found ${offered} thing${offered === 1 ? "" : "s"} in ${found.scope.dir} that this project does not declare.`,
  );
  deps.say(
    `Each one can go to the Manifest — committed, and what a teammate gets — or to your Overlay, which is ` +
      `personal and uncommitted. Nothing in your user scope is changed either way.`,
  );

  if (result.alreadyDeclared.length > 0) {
    deps.say("");
    deps.say(`  already declared, so not offered  (${result.alreadyDeclared.length})`);
    const width = column(result.alreadyDeclared);
    for (const item of result.alreadyDeclared) {
      deps.say(`    ${pad(item.name, width)}  in the ${item.declared}`);
    }
  }
}

function finish(result: ImportResult, deps: ImportDeps): ImportResult {
  deps.say("");
  if (result.assigned.length === 0) {
    deps.say(`Nothing was imported, and nothing was written.`);
    return result;
  }

  const to = (destination: string) => result.assigned.filter((entry) => entry.destination === destination).length;
  deps.say(
    `Imported ${result.assigned.length}: ${to("manifest")} into the Manifest, ${to("overlay")} into your Overlay.` +
      (result.skipped.length > 0 ? ` ${result.skipped.length} skipped.` : ""),
  );
  for (const path of result.written) deps.say(`  wrote ${path}`);

  for (const item of result.flagged) {
    deps.say("");
    deps.say(`  ${item.name} is declared by local path, which no clone of this project can resolve.`);
    deps.say(`    ${item.local}`);
    deps.say(`    Then: harv add ${item.name} --git <repository>#<subdirectory>  (replacing the entry)`);
  }
  for (const note of result.notes) deps.say(`  note: ${note}`);

  deps.say("");
  deps.say(`Run \`harv sync\` to resolve what you just declared, then \`harv claude\`.`);
  return result;
}

const read = (path: string): string | undefined => (existsSync(path) ? readFileSync(path, "utf8") : undefined);
