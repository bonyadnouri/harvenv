/**
 * The Manifest's `[mcp]` table, turned into the payload the Launcher injects
 * with `--strict-mcp-config --mcp-config`.
 *
 * Strict mode is what makes the section mean anything: the servers a session
 * runs with are exactly the ones the Manifest declares, and the machine's own
 * servers — global and per-project alike, configured in `~/.claude.json`, which
 * is not a settings source — do not load. Suppressing them is why the recipe has
 * two MCP flags rather than relying on `--setting-sources` (spike 0001).
 *
 * ## Secrets
 *
 * A server definition is committed, so it cannot carry the token the server
 * needs. `${VAR}` is the seam: the Manifest names a variable, and harv resolves
 * it from the environment of the person launching the session. The value exists
 * for the length of one `claude` process and is never written anywhere — not
 * into the Manifest, not into the project tree, not into a generated file.
 *
 * harv resolves the references itself rather than passing them through for
 * Claude Code to expand, even though Claude Code does expand `${VAR}` in an
 * inline `--mcp-config` payload. Two measured reasons (spike 0002, finding 4):
 * an *unset* variable is substituted as the literal string `${VAR}` and the
 * server connects anyway, so a missing credential surfaces as a puzzling
 * authentication failure instead of an error naming the variable; and the
 * expansion is observed behaviour on fields harv would have to map one by one.
 * The same lesson the settings payload taught — harv owns the payload, rather
 * than leaning on precedence or expansion to enforce its rules on its behalf.
 *
 * The cost, stated plainly: a resolved payload travels in `claude`'s argv, which
 * is visible to other processes on the machine (`ps`). That is a real exposure,
 * accepted here because the alternative — a generated file — is the one thing
 * this design exists to avoid, and because leaning on Claude Code's expansion
 * trades it for silent breakage when a variable is unset.
 */

/**
 * Transports a `--mcp-config` payload may declare on Claude Code 2.1.223, each
 * paired with the key that decides it when `type` is left out. (`sse-ide`,
 * `ws-ide` and `claudeai-proxy` exist in the schema but are internal-only.)
 */
const TRANSPORT_FIELD = { stdio: "command", http: "url" } as const;

type Transport = keyof typeof TRANSPORT_FIELD;

const TRANSPORTS = Object.keys(TRANSPORT_FIELD) as Transport[];

const isTransport = (value: unknown): value is Transport =>
  typeof value === "string" && Object.hasOwn(TRANSPORT_FIELD, value);

/** `${VAR}` — the only reference syntax harv understands. */
const REFERENCE = /\$\{([^}]*)\}/g;
const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export interface McpServerEntry {
  /** The Manifest key — and the name the session's `mcp__<server>__*` tools carry. */
  name: string;
  /** The server definition, `${VAR}` references still unresolved. */
  definition: Record<string, unknown>;
}

export class McpError extends Error {
  override name = "McpError";
}

/**
 * Throws if the Manifest declares a server Claude Code would not run, or one
 * whose `${VAR}` references the launching environment cannot satisfy.
 *
 * Exported so the whole Manifest can be judged before the first write into the
 * project tree, for the same reason `validateSettings` is.
 */
export function validateMcpServers(servers: McpServerEntry[], env: NodeJS.ProcessEnv): void {
  // The generator is the implementation of both jobs; discarding its output is
  // how "check it" and "build it" stay one piece of code rather than two that
  // can disagree.
  generateMcpConfig(servers, env);
}

/**
 * The Harvenv's MCP servers as a `--mcp-config` payload, with every `${VAR}`
 * resolved. An empty declaration still produces `{"mcpServers":{}}` — under
 * `--strict-mcp-config` that is not a no-op, it is the instruction that no
 * server loads.
 */
export function generateMcpConfig(servers: McpServerEntry[], env: NodeJS.ProcessEnv): string {
  const mcpServers: Record<string, unknown> = {};
  for (const server of servers) {
    validateDefinition(server);
    mcpServers[server.name] = resolve(server.definition, server.name, env);
  }
  return JSON.stringify({ mcpServers });
}

function validateDefinition({ name, definition }: McpServerEntry): void {
  const where = `[mcp.${name}]`;

  const declared: unknown = definition.type;
  if (declared !== undefined && !isTransport(declared)) {
    // A transport Claude Code does not recognise takes the whole server down in
    // silence: it simply does not appear in the session (spike 0002, finding 3).
    throw new McpError(
      `${where} type = ${JSON.stringify(declared)} is not a transport Claude Code runs, and the server would be ` +
        `dropped without a word. Use one of: ${TRANSPORTS.join(", ")}.`,
    );
  }

  const present = TRANSPORTS.filter((t) => TRANSPORT_FIELD[t] in definition);
  if (present.length === 0) {
    throw new McpError(
      `${where} declares no transport. A server needs \`command\` (stdio) or \`url\` (http), e.g. ` +
        `command = "npx" with args = ["-y", "some-mcp-server"].`,
    );
  }
  if (present.length > 1) {
    throw new McpError(
      `${where} declares both \`command\` and \`url\`, so its transport is ambiguous. Keep the one the server uses.`,
    );
  }

  const transport = isTransport(declared) ? declared : present[0]!;
  const field = TRANSPORT_FIELD[transport];
  if (!(field in definition)) {
    throw new McpError(
      `${where} is type = "${transport}", which needs \`${field}\`, ` +
        `but declares \`${TRANSPORT_FIELD[present[0]!]}\` instead.`,
    );
  }
  requireNonEmptyString(definition[field], `${where} ${field}`);

  if ("args" in definition) {
    const args = definition.args;
    if (!Array.isArray(args) || args.some((a) => typeof a !== "string")) {
      throw new McpError(`${where} args must be an array of strings, e.g. args = ["-y", "some-mcp-server"]`);
    }
  }
  for (const key of ["env", "headers"]) {
    if (!(key in definition)) continue;
    const table = definition[key];
    if (!isTable(table) || Object.values(table).some((v) => typeof v !== "string")) {
      throw new McpError(
        `${where} ${key} must be a table of string values, e.g. ${key} = { TOKEN = "\${MY_TOKEN}" }`,
      );
    }
  }
}

function requireNonEmptyString(value: unknown, where: string): void {
  if (typeof value !== "string" || value.length === 0) {
    throw new McpError(`${where} must be a non-empty string, but is ${JSON.stringify(value)}`);
  }
}

/** Every string in the definition, with its `${VAR}` references substituted. */
function resolve(value: unknown, server: string, env: NodeJS.ProcessEnv): unknown {
  if (typeof value === "string") return substitute(value, server, env);
  if (Array.isArray(value)) return value.map((item) => resolve(item, server, env));
  if (isTable(value)) {
    // Keys are names — of environment variables, of headers — and a name is not
    // a place a secret belongs, so only values are substituted.
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, resolve(v, server, env)]));
  }
  return value;
}

function substitute(value: string, server: string, env: NodeJS.ProcessEnv): string {
  return value.replace(REFERENCE, (_match, name: string) => {
    if (!VARIABLE_NAME.test(name)) {
      throw new McpError(
        `[mcp.${server}] contains \${${name}}, which is not an environment variable reference harv understands. ` +
          `The syntax is \${NAME}, where NAME starts with a letter or underscore.`,
      );
    }
    const resolved = env[name];
    if (resolved === undefined) {
      // Loud, and loud *here*: Claude Code would substitute the literal
      // `${NAME}` and let the server connect with it (spike 0002, finding 4).
      throw new McpError(
        `[mcp.${server}] references \${${name}}, but ${name} is not set in this environment. ` +
          `Export it before launching — harv resolves it at launch and never stores it.`,
      );
    }
    return resolved;
  });
}

const isTable = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);
