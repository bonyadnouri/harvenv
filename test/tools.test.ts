import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { loadManifest, ManifestError } from "../src/manifest.ts";
import type { Manifest } from "../src/manifest.ts";
import { readRequires, requirements, resolveToolchain, ToolchainError } from "../src/tools.ts";
import type { ToolchainDeps } from "../src/tools.ts";
import type { ResolvedTool } from "../src/tools.ts";
import { tempDir } from "./helpers.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function project(body: string): Manifest {
  const root = tempDir();
  writeFileSync(join(root, "harvenv.toml"), body);
  return loadManifest(join(root, "harvenv.toml"));
}

/** A skill directory whose SKILL.md carries `frontmatter` verbatim. */
function skill(name: string, frontmatter: string): { name: string; path: string } {
  const path = join(tempDir(), name);
  mkdirSync(path, { recursive: true });
  writeFileSync(join(path, "SKILL.md"), `---\nname: ${name}\n${frontmatter}---\n\nBody.\n`);
  return { name, path };
}

/** Any path will do: every engine call is faked, and only the calls are asserted. */
const MISE = "/fake/mise";

/**
 * An engine that records every call. Faking it is the point: what these tests
 * assert is *which* calls a Toolchain makes, and above all which it does not.
 */
function engine(overrides: Partial<ToolchainDeps> = {}): ToolchainDeps & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    env: {},
    findMise: () => ({ bin: MISE }),
    resolveVersion: (_mise, tool, spec) => {
      calls.push(`resolve ${tool}@${spec}`);
      return spec === "latest" ? "9.9.9" : `${spec}.0`;
    },
    isKnown: (_mise, tool) => {
      calls.push(`known ${tool}`);
      return true;
    },
    install: (_mise, tool, version) => {
      calls.push(`install ${tool}@${version}`);
    },
    binPaths: (_mise, tool, version) => {
      calls.push(`binPaths ${tool}@${version}`);
      return [`installs/${tool}/${version}/bin`];
    },
    hasBins: (bins) => {
      calls.push(`hasBins ${bins.join(",")}`);
      return false;
    },
    ...overrides,
  };
}

const locked = (...tools: ResolvedTool[]): Map<string, ResolvedTool> =>
  new Map(tools.map((tool) => [tool.tool, tool]));

// ---------------------------------------------------------------------------
// The Manifest's `[tools]`
// ---------------------------------------------------------------------------

test("a Manifest declares its Toolchain as tool to version spec", () => {
  const manifest = project(`[tools]\nnode = "22.18"\nripgrep = "latest"\n`);

  assert.deepEqual(manifest.tools, [
    { tool: "node", spec: "22.18" },
    { tool: "ripgrep", spec: "latest" },
  ]);
});

test("a Manifest with no [tools] has an empty Toolchain", () => {
  assert.deepEqual(project(`[skills]\n`).tools, []);
});

test("a backend-qualified tool name is a usable declaration", () => {
  assert.deepEqual(project(`[tools]\n"npm:prettier" = "3"\n`).tools, [{ tool: "npm:prettier", spec: "3" }]);
});

test("a [tools] entry that is not a version string is rejected by name", () => {
  assert.throws(
    () => project(`[tools]\nnode = { version = "22" }\n`),
    (err: Error) => err instanceof ManifestError && err.message.includes("`node`") && err.message.includes('= "22.18"'),
  );
});

test("a version spec that could arrive as a flag is refused", () => {
  assert.throws(
    () => project(`[tools]\nnode = "--version"\n`),
    (err: Error) => err instanceof ManifestError && err.message.includes("version"),
  );
});

test("a tool name that could climb out of the Store is refused", () => {
  assert.throws(
    () => project(`[tools]\n"../../etc" = "1"\n`),
    (err: Error) => err instanceof ManifestError && err.message.includes("tool name"),
  );
});

// ---------------------------------------------------------------------------
// A Component's `requires`
// ---------------------------------------------------------------------------

test("a skill declares what it needs on one line", () => {
  const alpha = skill("alpha", "requires: node@22, ripgrep\n");

  assert.deepEqual(readRequires(alpha.path, "alpha"), [
    { tool: "node", spec: "22", from: "skill `alpha`" },
    { tool: "ripgrep", spec: "latest", from: "skill `alpha`" },
  ]);
});

test("a skill declares what it needs as a YAML list", () => {
  const alpha = skill("alpha", "requires:\n  - node@22\n  - ripgrep\ndescription: after the list\n");

  assert.deepEqual(
    readRequires(alpha.path, "alpha").map((r) => `${r.tool}@${r.spec}`),
    ["node@22", "ripgrep@latest"],
  );
});

test("a skill declares what it needs as a flow sequence", () => {
  const alpha = skill("alpha", "requires: [node@22, ripgrep]\n");

  assert.deepEqual(
    readRequires(alpha.path, "alpha").map((r) => `${r.tool}@${r.spec}`),
    ["node@22", "ripgrep@latest"],
  );
});

test("the key after a requires list ends it", () => {
  const alpha = skill("alpha", "requires:\n  - node@22\ndescription: not a requirement\n");

  assert.deepEqual(readRequires(alpha.path, "alpha").length, 1);
});

test("a skill that requires nothing contributes nothing", () => {
  assert.deepEqual(readRequires(skill("alpha", "").path, "alpha"), []);
});

test("a skill with no SKILL.md contributes nothing rather than failing here", () => {
  assert.deepEqual(readRequires(tempDir(), "alpha"), []);
});

test("a scoped package name keeps its leading @", () => {
  const alpha = skill("alpha", "requires: npm:@scope/pkg@1.2\n");

  assert.deepEqual(readRequires(alpha.path, "alpha"), [
    { tool: "npm:@scope/pkg", spec: "1.2", from: "skill `alpha`" },
  ]);
});

test("a requirement whose version could arrive as a flag is refused, naming the skill", () => {
  const alpha = skill("alpha", "requires: node@--help\n");

  assert.throws(
    () => readRequires(alpha.path, "alpha"),
    (err: Error) => err instanceof ToolchainError && err.message.includes("skill `alpha`"),
  );
});

// ---------------------------------------------------------------------------
// Gathering requirements
// ---------------------------------------------------------------------------

test("a Component's requirement becomes part of the Toolchain", () => {
  const required = requirements(project(""), [skill("alpha", "requires: node@22\n")]);

  assert.deepEqual(required, [{ tool: "node", spec: "22", from: "skill `alpha`" }]);
});

test("the Manifest's pin overrides what a Component asked for (ADR 0005)", () => {
  const required = requirements(project(`[tools]\nnode = "24"\n`), [skill("alpha", "requires: node@22\n")]);

  assert.deepEqual(required, [{ tool: "node", spec: "24", from: "the Manifest" }]);
});

test("two Components agreeing on a version produce one requirement", () => {
  const required = requirements(project(""), [
    skill("alpha", "requires: node@22\n"),
    skill("beta", "requires: node@22\n"),
  ]);

  assert.deepEqual(required.length, 1);
});

test("two Components disagreeing on a version is settled in the Manifest, not guessed", () => {
  assert.throws(
    () =>
      requirements(project(""), [skill("alpha", "requires: node@22\n"), skill("beta", "requires: node@24\n")]),
    (err: Error) =>
      err instanceof ToolchainError &&
      err.message.includes("skill `alpha`") &&
      err.message.includes("skill `beta`") &&
      err.message.includes('[tools] node = "24"'),
  );
});

test("a Manifest pin settles what two Components disagree about", () => {
  const required = requirements(project(`[tools]\nnode = "22"\n`), [
    skill("alpha", "requires: node@22\n"),
    skill("beta", "requires: node@24\n"),
  ]);

  assert.deepEqual(required, [{ tool: "node", spec: "22", from: "the Manifest" }]);
});

// ---------------------------------------------------------------------------
// Resolving into the Store
// ---------------------------------------------------------------------------

test("a requirement resolves to an exact version, installs, and records its bin paths", () => {
  const mise = engine();
  const result = resolveToolchain([{ tool: "node", spec: "22", from: "the Manifest" }], locked(), mise);

  assert.deepEqual(result.tools, [
    { tool: "node", spec: "22", version: "22.0", bins: ["installs/node/22.0/bin"] },
  ]);
  assert.deepEqual(result.installed, ["node@22.0"]);
  assert.deepEqual(mise.calls, ["resolve node@22", "install node@22.0", "binPaths node@22.0"]);
});

test("a locked tool the Store already holds costs no engine call at all", () => {
  const mise = engine({ hasBins: () => true });
  const result = resolveToolchain(
    [{ tool: "node", spec: "22", from: "the Manifest" }],
    locked({ tool: "node", spec: "22", version: "22.18.0", bins: ["installs/node/22.18.0/bin"] }),
    mise,
  );

  assert.deepEqual(result.reused, ["node@22.18.0"]);
  assert.deepEqual(result.installed, []);
  // The whole claim: nothing was resolved, and nothing was installed.
  assert.deepEqual(
    mise.calls.filter((call) => !call.startsWith("hasBins")),
    [],
  );
});

test("a locked version the Store lost is installed again, not re-resolved", () => {
  const mise = engine({ hasBins: () => false });
  resolveToolchain(
    [{ tool: "node", spec: "22", from: "the Manifest" }],
    locked({ tool: "node", spec: "22", version: "22.18.0", bins: ["installs/node/22.18.0/bin"] }),
    mise,
  );

  assert.ok(mise.calls.includes("install node@22.18.0"), mise.calls.join(", "));
  assert.ok(!mise.calls.some((call) => call.startsWith("resolve")), mise.calls.join(", "));
});

test("a spec the Manifest moved is resolved again, ignoring the old pin", () => {
  const mise = engine({ hasBins: () => true });
  resolveToolchain(
    [{ tool: "node", spec: "24", from: "the Manifest" }],
    locked({ tool: "node", spec: "22", version: "22.18.0", bins: ["installs/node/22.18.0/bin"] }),
    mise,
  );

  assert.ok(mise.calls.includes("resolve node@24"), mise.calls.join(", "));
  assert.ok(mise.calls.includes("install node@24.0"), mise.calls.join(", "));
});

test("a tool the engine cannot install degrades to a recorded hint, not a failure", () => {
  const mise = engine({ resolveVersion: () => null, isKnown: () => false });
  const result = resolveToolchain([{ tool: "obscurity", spec: "1", from: "skill `alpha`" }], locked(), mise);

  assert.deepEqual(result.unscopeable, ["obscurity"]);
  assert.deepEqual(result.tools[0]?.version, undefined);
  assert.match(result.tools[0]?.hint ?? "", /no scoped installer/);
  assert.match(result.tools[0]?.hint ?? "", /skill `alpha`/);
  assert.deepEqual(result.warnings.length, 1);
});

test("a known tool with no matching version says so, rather than blaming the tool", () => {
  const mise = engine({ resolveVersion: () => null, isKnown: () => true });
  const result = resolveToolchain([{ tool: "node", spec: "99", from: "the Manifest" }], locked(), mise);

  assert.match(result.tools[0]?.hint ?? "", /no version matching/);
});

test("one unscopeable tool does not stop the ones beside it", () => {
  const mise = engine({
    resolveVersion: (_mise, tool, spec) => (tool === "obscurity" ? null : `${spec}.0`),
    isKnown: () => false,
  });
  const result = resolveToolchain(
    [
      { tool: "node", spec: "22", from: "the Manifest" },
      { tool: "obscurity", spec: "1", from: "the Manifest" },
    ],
    locked(),
    mise,
  );

  assert.deepEqual(result.installed, ["node@22.0"]);
  assert.deepEqual(result.unscopeable, ["obscurity"]);
});

test("a machine with no engine degrades every requirement at once, and says so once", () => {
  const mise = engine({ findMise: () => ({ unavailable: "no vendored mise for this platform" }) });
  const result = resolveToolchain(
    [
      { tool: "node", spec: "22", from: "the Manifest" },
      { tool: "ripgrep", spec: "latest", from: "skill `alpha`" },
    ],
    locked(),
    mise,
  );

  assert.deepEqual(result.unscopeable, ["node", "ripgrep"]);
  assert.deepEqual(result.warnings.length, 1);
  assert.match(result.warnings[0] ?? "", /no vendored mise/);
  assert.deepEqual(mise.calls, []);
});

test("a Harvenv that needs no tools never looks for an engine", () => {
  const mise = engine({
    findMise: () => {
      throw new Error("the Toolchain looked for an engine it had no reason to want");
    },
  });

  assert.deepEqual(resolveToolchain([], locked(), mise).tools, []);
});
