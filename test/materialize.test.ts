import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

import { materialize, MaterializeError, MATERIALIZED_STATE_FILE, pluginDir } from "../src/materialize.ts";
import type { MaterializePlan } from "../src/materialize.ts";
import { marketplaceFile, pluginFile, skillFile, tempDir } from "./helpers.ts";

/** A skill directory on disk, outside any project — a stand-in for the Store. */
function skillAt(dir: string, name: string, frontmatterName = name): string {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), skillFile(frontmatterName));
  return dir;
}

const planFor = (root: string, skills: MaterializePlan["skills"]): MaterializePlan => ({ root, skills });

const skillsDir = (root: string) => join(root, ".claude", "skills");

test("materialize links a declared skill into project scope under its Manifest name", () => {
  const root = tempDir();
  const source = skillAt(join(tempDir(), "example-skill"), "example-skill");

  materialize(planFor(root, [{ name: "example-skill", path: source }]));

  const link = join(skillsDir(root), "example-skill");
  assert.equal(lstatSync(link).isSymbolicLink(), true, "materialized as a symlink, not a copy");
  assert.equal(readlinkSync(link), source);
  assert.match(readFileSync(join(link, "SKILL.md"), "utf8"), /name: example-skill/);
});

test("materialize is idempotent across runs", () => {
  const root = tempDir();
  const source = skillAt(join(tempDir(), "example-skill"), "example-skill");
  const manifest = planFor(root, [{ name: "example-skill", path: source }]);

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
    planFor(root, [
      { name: "kept-skill", path: kept },
      { name: "dropped-skill", path: dropped },
    ]),
  );
  const result = materialize(planFor(root, [{ name: "kept-skill", path: kept }]));

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
    () => materialize(planFor(root, [{ name: "example-skill", path: source }])),
    (err: Error) => err instanceof MaterializeError && /example-skill/.test(err.message),
  );
});

test("materialize leaves hand-written project skills it never owned alone", () => {
  const root = tempDir();
  const source = skillAt(join(tempDir(), "declared-skill"), "declared-skill");
  const handWritten = skillAt(join(skillsDir(root), "hand-written"), "hand-written");

  materialize(planFor(root, [{ name: "declared-skill", path: source }]));

  assert.equal(existsSync(join(handWritten, "SKILL.md")), true);
});

test("materialize rejects a skill path that does not exist", () => {
  const root = tempDir();

  assert.throws(
    () => materialize(planFor(root, [{ name: "missing", path: join(root, "nope") }])),
    (err: Error) => err instanceof MaterializeError && /nope/.test(err.message),
  );
});

test("materialize rejects a skill directory with no SKILL.md", () => {
  const root = tempDir();
  const empty = join(tempDir(), "empty-skill");
  mkdirSync(empty, { recursive: true });

  assert.throws(
    () => materialize(planFor(root, [{ name: "empty-skill", path: empty }])),
    (err: Error) => err instanceof MaterializeError && /SKILL\.md/.test(err.message),
  );
});

test("materialize rejects a skill whose own name differs from its Manifest key", () => {
  const root = tempDir();
  const source = skillAt(join(tempDir(), "example-skill"), "published-name");

  assert.throws(
    () => materialize(planFor(root, [{ name: "declared-name", path: source }])),
    (err: Error) =>
      err instanceof MaterializeError &&
      /declared-name/.test(err.message) &&
      /published-name/.test(err.message),
  );
});

test("materialize records what it owns so a later run can reverse it", () => {
  const root = tempDir();
  const source = skillAt(join(tempDir(), "example-skill"), "example-skill");

  materialize(planFor(root, [{ name: "example-skill", path: source }]));

  const state = JSON.parse(readFileSync(join(root, ".claude", MATERIALIZED_STATE_FILE), "utf8"));
  assert.deepEqual(state.skills, ["example-skill"]);
});

test("materialize accepts a SKILL.md whose name is quoted, as YAML allows", () => {
  const root = tempDir();
  const source = join(tempDir(), "example-skill");
  mkdirSync(source, { recursive: true });
  writeFileSync(
    join(source, "SKILL.md"),
    '---\nname: "example-skill"\ndescription: Fixture skill for harvenv tests.\n---\n\nMarker.\n',
  );

  materialize(planFor(root, [{ name: "example-skill", path: source }]));

  assert.equal(existsSync(join(skillsDir(root), "example-skill", "SKILL.md")), true);
});

test("materialize refuses a skill name that would place a link outside the skills directory", () => {
  const root = tempDir();
  // The skill's own name agrees with the key, so only the escape guard can
  // reject this — the name-agreement check has nothing to complain about.
  const source = skillAt(join(tempDir(), "agents"), "../agents", "../agents");
  const sibling = join(root, ".claude", "agents");
  mkdirSync(sibling, { recursive: true });
  writeFileSync(join(sibling, "hand-written.md"), "mine\n");

  assert.throws(
    () => materialize(planFor(root, [{ name: "../agents", path: source }])),
    (err: Error) => err instanceof MaterializeError && /single path segment/.test(err.message),
  );
  assert.equal(existsSync(join(sibling, "hand-written.md")), true, "the sibling directory is untouched");
});

test("materialize ignores an ownership record naming a path outside the skills directory", () => {
  const root = tempDir();
  const sibling = join(root, ".claude", "agents");
  mkdirSync(sibling, { recursive: true });
  writeFileSync(join(sibling, "hand-written.md"), "mine\n");
  // A state file harv would never write, but the project tree is not harv's to trust.
  writeFileSync(
    join(root, ".claude", MATERIALIZED_STATE_FILE),
    JSON.stringify({ version: 1, skills: ["../agents"] }),
  );

  materialize(planFor(root, []));

  assert.equal(existsSync(join(sibling, "hand-written.md")), true);
});

// ---------------------------------------------------------------------------
// Plugins — linked under their own name, because that name is what serves them
// ---------------------------------------------------------------------------

/** A plugin directory whose name is a hash digest, exactly as the Store holds it. */
function pluginAt(digest: string, declaredName: string | null): string {
  const dir = join(tempDir(), digest);
  mkdirSync(join(dir, "skills", "packaged-skill"), { recursive: true });
  writeFileSync(join(dir, "skills", "packaged-skill", "SKILL.md"), skillFile("packaged-skill"));
  if (declaredName !== null) {
    mkdirSync(join(dir, ".claude-plugin"), { recursive: true });
    writeFileSync(join(dir, ".claude-plugin", "plugin.json"), pluginFile(declaredName));
  }
  return dir;
}

test("materialize links a pinned plugin under its own name, not the Store's", () => {
  const root = tempDir();
  const source = pluginAt("f3a9c2b10e4d5678", "alpha-pack");

  const result = materialize({ root, skills: [], plugins: [{ name: "alpha-pack", path: source }] });

  const link = pluginDir(root, "alpha-pack");
  assert.deepEqual(result.plugins, ["alpha-pack"]);
  assert.equal(lstatSync(link).isSymbolicLink(), true, "linked, so the Store keeps the only copy");
  assert.equal(readlinkSync(link), source);
  assert.equal(basename(link), "alpha-pack", "the directory a session is pointed at is the plugin's name");
});

test("materialize links a plugin that declares no name of its own", () => {
  // Real marketplaces publish these. The link's name is then the only name the
  // session can use, which is precisely why harv creates one.
  const root = tempDir();
  const source = pluginAt("0f1e2d3c4b5a6978", null);

  materialize({ root, skills: [], plugins: [{ name: "nameless-pack", path: source }] });

  assert.equal(readlinkSync(pluginDir(root, "nameless-pack")), source);
});

test("materialize refuses a plugin published under a name other than its pin", () => {
  const root = tempDir();
  const source = pluginAt("aaaabbbbccccdddd", "superpowers-dev");

  assert.throws(
    () => materialize({ root, skills: [], plugins: [{ name: "superpowers", path: source }] }),
    (err: Error) =>
      err instanceof MaterializeError && /superpowers-dev/.test(err.message) && /superpowers/.test(err.message),
  );
  assert.equal(existsSync(pluginDir(root, "superpowers")), false, "nothing is linked from a rejected plan");
});

test("materialize refuses a whole marketplace served as one plugin", () => {
  const root = tempDir();
  const source = pluginAt("bbbbccccddddeeee", null);
  mkdirSync(join(source, ".claude-plugin"), { recursive: true });
  writeFileSync(join(source, ".claude-plugin", "marketplace.json"), marketplaceFile("fixtures", { alpha: "./" }));

  assert.throws(
    () => materialize({ root, skills: [], plugins: [{ name: "alpha", path: source }] }),
    (err: Error) => err instanceof MaterializeError && /marketplace/.test(err.message),
  );
});

test("materialize removes a plugin it created once the Manifest stops pinning it", () => {
  const root = tempDir();
  const kept = pluginAt("1111222233334444", "kept-pack");
  const dropped = pluginAt("5555666677778888", "dropped-pack");

  materialize({
    root,
    skills: [],
    plugins: [
      { name: "kept-pack", path: kept },
      { name: "dropped-pack", path: dropped },
    ],
  });
  const result = materialize({ root, skills: [], plugins: [{ name: "kept-pack", path: kept }] });

  assert.deepEqual(result.removed, ["dropped-pack"]);
  assert.equal(existsSync(pluginDir(root, "dropped-pack")), false);
  assert.equal(existsSync(pluginDir(root, "kept-pack")), true);
});

test("materialize refuses to clobber a plugin directory it did not create", () => {
  const root = tempDir();
  const mine = pluginDir(root, "alpha-pack");
  mkdirSync(mine, { recursive: true });
  writeFileSync(join(mine, "hand-written.md"), "mine\n");

  assert.throws(
    () => materialize({ root, skills: [], plugins: [{ name: "alpha-pack", path: pluginAt("99998888", "alpha-pack") }] }),
    (err: Error) => err instanceof MaterializeError && /did not create it/.test(err.message),
  );
  assert.equal(readFileSync(join(mine, "hand-written.md"), "utf8"), "mine\n");
});

test("a skill and a plugin of the same name are materialized side by side", () => {
  const root = tempDir();
  const skill = skillAt(join(tempDir(), "shared"), "shared");
  const plugin = pluginAt("ccccddddeeeeffff", "shared");

  materialize({ root, skills: [{ name: "shared", path: skill }], plugins: [{ name: "shared", path: plugin }] });

  assert.equal(readlinkSync(join(skillsDir(root), "shared")), skill);
  assert.equal(readlinkSync(pluginDir(root, "shared")), plugin);
});

test("a name that moves from [skills] to [plugins] loses its skill link and gains a plugin one", () => {
  const root = tempDir();
  const skill = skillAt(join(tempDir(), "shared"), "shared");
  const plugin = pluginAt("eeeeffff00001111", "shared");

  materialize({ root, skills: [{ name: "shared", path: skill }], plugins: [] });
  const result = materialize({ root, skills: [], plugins: [{ name: "shared", path: plugin }] });

  assert.deepEqual(result.removed, ["shared"]);
  assert.equal(existsSync(join(skillsDir(root), "shared")), false);
  assert.equal(readlinkSync(pluginDir(root, "shared")), plugin);
});

test("materialize ignores an ownership record naming a plugin path outside its directory", () => {
  const root = tempDir();
  const sibling = join(root, ".claude", "agents");
  mkdirSync(sibling, { recursive: true });
  writeFileSync(join(sibling, "hand-written.md"), "mine\n");
  writeFileSync(
    join(root, ".claude", MATERIALIZED_STATE_FILE),
    JSON.stringify({ version: 1, skills: [], plugins: ["../agents"] }),
  );

  materialize({ root, skills: [], plugins: [] });

  assert.equal(existsSync(join(sibling, "hand-written.md")), true);
});
