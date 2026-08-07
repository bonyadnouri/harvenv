/**
 * Reading answers from stdin — the one thing in harv that waits for a person.
 *
 * `readline`'s own `question()` is not enough, and the reason is the reason this
 * module exists: it hands over the *next* line to arrive, and a pipe does not
 * arrive a line at a time. `printf 'm\no\ns\n' | harv init --import` delivers
 * the whole script in one chunk, readline emits three `line` events at once,
 * and the two that nobody was waiting for are dropped — so the second and third
 * questions see an input that has already ended and are answered as if the user
 * had pressed return. The wizard then skips two thirds of what it offered and
 * reports success.
 *
 * That failure is invisible from a terminal, where the lines really do arrive
 * one at a time — and every scripted run, every CI invocation and every
 * verification harness is a pipe. So lines are queued here as they arrive and
 * handed out on demand, which makes a typed session and a piped script the same
 * thing from the wizard's side.
 *
 * An input that ends with a question outstanding answers it as empty rather
 * than hanging. Every caller reads an empty answer as "change nothing", which
 * is the only safe reading of a user who is not there.
 */

import { createInterface } from "node:readline";
import type { Interface } from "node:readline";
import type { Readable, Writable } from "node:stream";

export interface Prompt {
  /** Put one question, and resolve to the line that answers it. */
  ask: (question: string) => Promise<string>;
  /** Release the input, so a finished process is free to exit. */
  close: () => void;
}

export function prompt(input: Readable, output: Writable): Prompt {
  // `terminal` decides whether readline echoes and edits. A pipe wants neither;
  // a person wants both, and gets them from the tty this is attached to.
  const reader: Interface = createInterface({
    input,
    output,
    terminal: (input as Readable & { isTTY?: boolean }).isTTY === true,
  });

  /** Lines that arrived before anybody asked for them. */
  const typed: string[] = [];
  /** Questions asked before a line arrived, oldest first. */
  const waiting: Array<(answer: string) => void> = [];
  let ended = false;

  reader.on("line", (line: string) => {
    const next = waiting.shift();
    if (next === undefined) typed.push(line);
    else next(line);
  });
  reader.on("close", () => {
    ended = true;
    for (const next of waiting.splice(0)) next("");
  });

  return {
    ask: (question) => {
      output.write(question);
      const line = typed.shift();
      if (line !== undefined) return Promise.resolve(line);
      if (ended) return Promise.resolve("");
      return new Promise<string>((resolve) => waiting.push(resolve));
    },
    close: () => reader.close(),
  };
}
