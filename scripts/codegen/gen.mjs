#!/usr/bin/env node
// Orchestrates all codegen: TypeScript (openapi-typescript + json-schema-to-typescript
// via packages/ts-contracts) then Go/TS proto stubs via `buf generate`.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../..", import.meta.url));
const protoDir = join(root, "proto");

function run(cmd, args, cwd) {
  console.log(`$ ${cmd} ${args.join(" ")}`);
  const result = spawnSync(cmd, args, { cwd, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

run("pnpm", ["--filter", "@oe/ts-contracts", "run", "generate"], root);

if (existsSync(join(protoDir, "buf.yaml"))) {
  run("buf", ["generate", "--template", "buf.gen.yaml"], protoDir);
} else {
  console.log("proto/buf.yaml not found; skipping buf generate.");
}
