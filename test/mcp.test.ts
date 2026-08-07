import { test } from "node:test";
import assert from "node:assert/strict";

import { generateMcpConfig, McpError } from "../src/mcp.ts";
import type { McpServerEntry } from "../src/mcp.ts";

const server = (definition: Record<string, unknown>, name = "tickets"): McpServerEntry[] => [
  { name, definition },
];

const config = (servers: McpServerEntry[], env: NodeJS.ProcessEnv = {}): Record<string, unknown> =>
  JSON.parse(generateMcpConfig(servers, env)).mcpServers;

/** Asserts a rejection, and that its message says enough to act on. */
function rejects(servers: McpServerEntry[], env: NodeJS.ProcessEnv, ...mustMention: RegExp[]): void {
  assert.throws(
    () => generateMcpConfig(servers, env),
    (err: Error) => {
      assert.ok(err instanceof McpError, `expected an McpError, got ${err.name}`);
      for (const pattern of mustMention) assert.match(err.message, pattern);
      return true;
    },
  );
}

test("generateMcpConfig emits an empty server map when the Manifest declares none", () => {
  // Not a no-op: under --strict-mcp-config this is what suppresses the
  // machine's own servers.
  assert.equal(generateMcpConfig([], {}), '{"mcpServers":{}}');
});

test("generateMcpConfig carries a stdio definition through unchanged", () => {
  const definition = { command: "npx", args: ["-y", "tickets-mcp"], env: { REGION: "eu" } };

  assert.deepEqual(config(server(definition)), { tickets: definition });
});

test("generateMcpConfig carries an http definition through unchanged", () => {
  const definition = { type: "http", url: "https://mcp.example.com/mcp" };

  assert.deepEqual(config(server(definition)), { tickets: definition });
});

// ---------------------------------------------------------------------------
// ${VAR}: resolved at launch, from the environment, never stored
// ---------------------------------------------------------------------------

test("generateMcpConfig resolves ${VAR} wherever a string appears in a definition", () => {
  const definition = {
    command: "${TICKETS_BIN}",
    args: ["--org", "${TICKETS_ORG}"],
    env: { TOKEN: "${TICKETS_TOKEN}" },
  };
  const env = { TICKETS_BIN: "tickets-mcp", TICKETS_ORG: "acme", TICKETS_TOKEN: "s3cret" };

  assert.deepEqual(config(server(definition), env), {
    tickets: { command: "tickets-mcp", args: ["--org", "acme"], env: { TOKEN: "s3cret" } },
  });
});

test("generateMcpConfig resolves a reference embedded in a larger string", () => {
  const definition = { type: "http", url: "https://x/mcp", headers: { Authorization: "Bearer ${KEY}" } };

  assert.deepEqual(config(server(definition), { KEY: "abc" }).tickets, {
    type: "http",
    url: "https://x/mcp",
    headers: { Authorization: "Bearer abc" },
  });
});

test("generateMcpConfig substitutes values but never keys", () => {
  const definition = { command: "npx", env: { "${NOT_A_SECRET}": "plain" } };

  assert.deepEqual(config(server(definition), { NOT_A_SECRET: "x" }).tickets, {
    command: "npx",
    env: { "${NOT_A_SECRET}": "plain" },
  });
});

test("generateMcpConfig fails loudly on an unset variable, naming it and the server", () => {
  // Claude Code would substitute the literal `${TICKETS_TOKEN}` and let the
  // server connect with it (spike 0002, finding 4) — hence the error here.
  rejects(server({ command: "npx", env: { TOKEN: "${TICKETS_TOKEN}" } }), {}, /TICKETS_TOKEN/, /mcp\.tickets/);
});

test("generateMcpConfig treats an empty string as set, because unsetting is a separate decision", () => {
  assert.deepEqual(config(server({ command: "npx", env: { TOKEN: "${T}" } }), { T: "" }).tickets, {
    command: "npx",
    env: { TOKEN: "" },
  });
});

test("generateMcpConfig rejects a reference syntax it does not understand", () => {
  rejects(server({ command: "npx", args: ["${TOKEN:-fallback}"] }), {}, /TOKEN:-fallback/, /\$\{NAME\}/);
});

// ---------------------------------------------------------------------------
// A definition Claude Code would drop is an error, not a shrug
// ---------------------------------------------------------------------------

test("generateMcpConfig rejects a transport Claude Code would drop without a word", () => {
  rejects(server({ type: "sse", url: "https://x/mcp" }), {}, /sse/, /stdio, http/);
});

test("generateMcpConfig rejects a definition with no transport at all", () => {
  rejects(server({ args: ["-y", "tickets-mcp"] }), {}, /mcp\.tickets/, /command/, /url/);
});

test("generateMcpConfig rejects a definition whose transport is ambiguous", () => {
  rejects(server({ command: "npx", url: "https://x/mcp" }), {}, /both/);
});

test("generateMcpConfig rejects a declared type that disagrees with the fields", () => {
  rejects(server({ type: "http", command: "npx" }), {}, /http/, /url/);
});

test("generateMcpConfig rejects malformed args, env and headers", () => {
  rejects(server({ command: "npx", args: "-y tickets-mcp" }), {}, /args/, /array/);
  rejects(server({ command: "npx", env: { TOKEN: 7 } }), {}, /env/, /string/);
  rejects(server({ type: "http", url: "https://x", headers: [] }), {}, /headers/, /string/);
  rejects(server({ command: "" }), {}, /command/, /non-empty/);
});
