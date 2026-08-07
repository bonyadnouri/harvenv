import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { findManifest, loadManifest, ManifestError } from "../src/manifest.ts";
import { tempDir } from "./helpers.ts";

/** Write a manifest into a fresh project and return its path. */
function manifestIn(root: string, contents: string): string {
  const path = join(root, "harvenv.toml");
  writeFileSync(path, contents);
  return path;
}

test("findManifest returns the manifest in the starting directory", () => {
  const root = tempDir();
  const manifest = join(root, "harvenv.toml");
  writeFileSync(manifest, "");

  assert.equal(findManifest(root), manifest);
});

test("findManifest walks up to the nearest ancestor holding a manifest", () => {
  const root = tempDir();
  const manifest = join(root, "harvenv.toml");
  writeFileSync(manifest, "");
  const nested = join(root, "src", "deep");
  mkdirSync(nested, { recursive: true });

  assert.equal(findManifest(nested), manifest);
});

test("findManifest returns null when no ancestor holds a manifest", () => {
  const root = tempDir();

  assert.equal(findManifest(root), null);
});

test("loadManifest resolves a skill's local path against the project root", () => {
  const root = tempDir();
  const path = manifestIn(root, '[skills]\nexample-skill = { path = "vendor/example-skill" }\n');

  const manifest = loadManifest(path);

  assert.equal(manifest.root, root);
  assert.deepEqual(manifest.skills, [
    {
      name: "example-skill",
      source: {
        kind: "path",
        declared: "vendor/example-skill",
        path: join(root, "vendor", "example-skill"),
      },
    },
  ]);
});

test("loadManifest reads a git Source with its ref and subdirectory", () => {
  const path = manifestIn(
    tempDir(),
    '[skills]\ngrill = { git = "https://example.com/s.git", ref = "v1.2.0", subdir = "skills/grill" }\n',
  );

  assert.deepEqual(loadManifest(path).skills, [
    {
      name: "grill",
      source: { kind: "git", repo: "https://example.com/s.git", ref: "v1.2.0", subdir: "skills/grill" },
    },
  ]);
});

test("loadManifest accepts a git Source with neither ref nor subdirectory", () => {
  const path = manifestIn(tempDir(), '[skills]\ngrill = { git = "https://example.com/s.git" }\n');

  assert.deepEqual(loadManifest(path).skills[0]?.source, {
    kind: "git",
    repo: "https://example.com/s.git",
  });
});

test("loadManifest rejects an entry declaring two Sources at once", () => {
  const path = manifestIn(
    tempDir(),
    '[skills]\ngrill = { git = "https://example.com/s.git", path = "vendor/grill" }\n',
  );

  assert.throws(
    () => loadManifest(path),
    (err: Error) => err instanceof ManifestError && /git/.test(err.message) && /path/.test(err.message),
  );
});

test("loadManifest rejects a ref or subdir with no repository to apply it to", () => {
  const path = manifestIn(tempDir(), '[skills]\ngrill = { path = "vendor/grill", ref = "v1" }\n');

  assert.throws(
    () => loadManifest(path),
    (err: Error) => err instanceof ManifestError && /ref/.test(err.message),
  );
});

test("loadManifest rejects a subdirectory that would escape the fetched repository", () => {
  for (const subdir of ["../elsewhere", "/etc", "skills/../../etc"]) {
    const path = manifestIn(
      tempDir(),
      `[skills]\ngrill = { git = "https://example.com/s.git", subdir = "${subdir}" }\n`,
    );

    assert.throws(
      () => loadManifest(path),
      (err: Error) => err instanceof ManifestError && /subdir/.test(err.message),
      `expected \`${subdir}\` to be rejected`,
    );
  }
});

test("loadManifest accepts a manifest that declares nothing", () => {
  const manifest = loadManifest(manifestIn(tempDir(), ""));

  assert.deepEqual(manifest.skills, []);
  assert.deepEqual(manifest.settings, {});
});

test("loadManifest carries the settings table through verbatim", () => {
  const path = manifestIn(tempDir(), '[settings]\nmodel = "opus"\n\n[settings.permissions]\ndefaultMode = "plan"\n');

  const manifest = loadManifest(path);

  assert.deepEqual(manifest.settings, { model: "opus", permissions: { defaultMode: "plan" } });
});

test("loadManifest rejects a skill declared without a source", () => {
  const path = manifestIn(tempDir(), "[skills]\nexample-skill = { }\n");

  assert.throws(
    () => loadManifest(path),
    (err: Error) =>
      err instanceof ManifestError && /example-skill/.test(err.message) && /path/.test(err.message),
  );
});

test("loadManifest rejects a source kind this version cannot fetch", () => {
  const path = manifestIn(tempDir(), '[skills]\nexample-skill = { marketplace = "anthropics/claude-code" }\n');

  assert.throws(
    () => loadManifest(path),
    (err: Error) => err instanceof ManifestError && /marketplace/.test(err.message),
  );
});

test("loadManifest rejects a skill entry that is not a table", () => {
  const path = manifestIn(tempDir(), '[skills]\nexample-skill = "vendor/example-skill"\n');

  assert.throws(() => loadManifest(path), ManifestError);
});

test("loadManifest reports a syntax error against the manifest path", () => {
  const root = tempDir();
  const path = manifestIn(root, "[skills\n");

  assert.throws(
    () => loadManifest(path),
    (err: Error) => err instanceof ManifestError && err.message.includes(path),
  );
});

test("loadManifest keeps an absolute skill path as given", () => {
  const path = manifestIn(tempDir(), '[skills]\nexample-skill = { path = "/opt/skills/example-skill" }\n');

  assert.deepEqual(loadManifest(path).skills[0]?.source, {
    kind: "path",
    declared: "/opt/skills/example-skill",
    path: "/opt/skills/example-skill",
  });
});

test("loadManifest rejects a skill name that would escape the skills directory", () => {
  for (const name of ["..", ".", "../agents", "a/b", "nested\\name", "../../etc/passwd"]) {
    const path = manifestIn(tempDir(), `[skills]\n"${name}" = { path = "vendor/x" }\n`);

    assert.throws(
      () => loadManifest(path),
      (err: Error) => err instanceof ManifestError && /name/i.test(err.message),
      `expected \`${name}\` to be rejected`,
    );
  }
});

test("loadManifest accepts the skill names Claude Code actually uses", () => {
  for (const name of ["grill-with-docs", "gsap_core", "web3d", "Skill.v2"]) {
    const path = manifestIn(tempDir(), `[skills]\n"${name}" = { path = "vendor/x" }\n`);

    assert.equal(loadManifest(path).skills[0]?.name, name);
  }
});
