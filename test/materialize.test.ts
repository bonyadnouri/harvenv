import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Manifest } from "../src/manifest.ts";
import { materialize, MaterializeError, MATERIALIZED_STATE_FILE } from "../src/materialize.ts";
import { tempDir } from "./helpers.ts";

/** A skill directory on disk, outside any project — a stand-in for the Store. */
function skillAt(dir: string, name: string, frontmatterName = name): string {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "SKILL.md"),
    `---\nname: ${frontmatterName}\ndescription: Fixture skill for harvenv tests.\n---\n\nMarker.\n`,
  );
  return dir;
}

function manifestFor(root: string, skills: Array<{ name: string; path: string }>): Manifest {
  return { path: join(root, "harvenv.toml"), root, skills, settings: {} };
}

const skillsDir = (root: string) => join(root, ".claude", "skills");

test("materialize links a declared skill into project scope under its Manifest name", () => {
  const root = tempDir();
  const source = skillAt(join(tempDir(), "example-skill"), "example-skill");

  materialize(manifestFor(root, [{ name: "example-skill", path: source }]));

  const link = join(skillsDir(root), "example-skill");
  assert.equal(lstatSync(link).isSymbolicLink(), true, "materialized as a symlink, not a copy");
  assert.equal(readlinkSync(link), source);
  assert.match(readFileSync(join(link, "SKILL.md"), "utf8"), /name: example-skill/);
});

test("materialize is idempotent across runs", () => {
  const root = tempDir();
  const source = skillAt(join(tempDir(), "example-skill"), "example-skill");
  const manifest = manifestFor(root, [{ name: "example-skill", path: source }]);

  materialize(manifest);
  const second = materialize(manifest);

  assert.deepEqual(second.linked, ["example-skill"]);
  assert.deepEqual(second.removed, []);
  assert.equal(readlinkSync(join(skillsDir(root), "example-skill")), source);
});

test("materialize removes a skill it created once the Manifest stops declaring it", () => {
  const root = tempDir();
  const store = tempDir();
  const kept = skillAt(join(store, "kept-skill"), "kept-skill");
  const dropped = skillAt(join(store, "dropped-skill"), "dropped-skill");

  materialize(
    manifestFor(root, [
      { name: "kept-skill", path: kept },
      { name: "dropped-skill", path: dropped },
    ]),
  );
  const result = materialize(manifestFor(root, [{ name: "kept-skill", path: kept }]));

  assert.deepEqual(result.removed, ["dropped-skill"]);
  assert.equal(existsSync(join(skillsDir(root), "dropped-skill")), false);
  assert.equal(existsSync(join(skillsDir(root), "kept-skill")), true);
  assert.equal(existsSync(join(store, "dropped-skill", "SKILL.md")), true, "the source is never touched");
});

test("materialize refuses to clobber a project skill it did not create", () => {
  const root = tempDir();
  const source = skillAt(join(tempDir(), "example-skill"), "example-skill");
  skillAt(join(skillsDir(root), "example-skill"), "example-skill");

  assert.throws(
    () => materialize(manifestFor(root, [{ name: "example-skill", path: source }])),
    (err: Error) => err instanceof MaterializeError && /example-skill/.test(err.message),
  );
});

test("materialize leaves hand-written project skills it never owned alone", () => {
  const root = tempDir();
  const source = skillAt(join(tempDir(), "declared-skill"), "declared-skill");
  const handWritten = skillAt(join(skillsDir(root), "hand-written"), "hand-written");

  materialize(manifestFor(root, [{ name: "declared-skill", path: source }]));

  assert.equal(existsSync(join(handWritten, "SKILL.md")), true);
});

test("materialize rejects a skill path that does not exist", () => {
  const root = tempDir();

  assert.throws(
    () => materialize(manifestFor(root, [{ name: "missing", path: join(root, "nope") }])),
    (err: Error) => err instanceof MaterializeError && /nope/.test(err.message),
  );
});

test("materialize rejects a skill directory with no SKILL.md", () => {
  const root = tempDir();
  const empty = join(tempDir(), "empty-skill");
  mkdirSync(empty, { recursive: true });

  assert.throws(
    () => materialize(manifestFor(root, [{ name: "empty-skill", path: empty }])),
    (err: Error) => err instanceof MaterializeError && /SKILL\.md/.test(err.message),
  );
});

test("materialize rejects a skill whose own name differs from its Manifest key", () => {
  const root = tempDir();
  const source = skillAt(join(tempDir(), "example-skill"), "published-name");

  assert.throws(
    () => materialize(manifestFor(root, [{ name: "declared-name", path: source }])),
    (err: Error) =>
      err instanceof MaterializeError &&
      /declared-name/.test(err.message) &&
      /published-name/.test(err.message),
  );
});

test("materialize records what it owns so a later run can reverse it", () => {
  const root = tempDir();
  const source = skillAt(join(tempDir(), "example-skill"), "example-skill");

  materialize(manifestFor(root, [{ name: "example-skill", path: source }]));

  const state = JSON.parse(readFileSync(join(root, ".claude", MATERIALIZED_STATE_FILE), "utf8"));
  assert.deepEqual(state.skills, ["example-skill"]);
});
