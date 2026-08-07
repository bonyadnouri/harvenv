#!/usr/bin/env node
import { defaultDeps, run } from "../src/cli.ts";

process.exitCode = await run(process.argv.slice(2), defaultDeps());
