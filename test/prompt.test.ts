import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";

import { prompt } from "../src/prompt.ts";

/** A prompt reading from a stream a test writes to, and a captured output. */
function reader() {
  const input = new PassThrough();
  const output = new PassThrough();
  let written = "";
  output.on("data", (chunk: Buffer) => {
    written += String(chunk);
  });
  return { input, output, written: () => written, prompt: prompt(input, output) };
}

test("answers arrive in the order they were typed, however fast they were typed", async () => {
  const { input, prompt: asker } = reader();
  // The whole script at once, which is what a pipe delivers: every line lands
  // before the second question is even asked.
  input.write("m\no\ns\n");

  assert.equal(await asker.ask("first? "), "m");
  assert.equal(await asker.ask("second? "), "o");
  assert.equal(await asker.ask("third? "), "s");
});

test("a question asked before anything is typed waits for the line", async () => {
  const { input, prompt: asker } = reader();

  const answer = asker.ask("well? ");
  setImmediate(() => input.write("later\n"));

  assert.equal(await answer, "later");
});

test("a question nothing answers resolves empty when the input runs out", async () => {
  const { input, prompt: asker } = reader();
  input.write("only one\n");

  assert.equal(await asker.ask("first? "), "only one");
  const second = asker.ask("second? ");
  input.end();

  assert.equal(await second, "", "no answer is not a hang");
});

test("a question asked after the input has already ended resolves empty too", async () => {
  const { input, prompt: asker } = reader();
  input.end();
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(await asker.ask("anything? "), "");
});

test("the question is written to the output, so a person can see what they are answering", async () => {
  const { input, written, prompt: asker } = reader();
  input.write("m\n");

  await asker.ask("Where do these go? ");

  assert.match(written(), /Where do these go\? /);
});

test("closing releases the input, so the process is free to exit", async () => {
  const { input, prompt: asker } = reader();

  asker.close();

  assert.equal(input.listenerCount("data"), 0, "nothing is left holding the stream open");
});
