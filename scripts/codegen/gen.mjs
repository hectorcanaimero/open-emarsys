#!/usr/bin/env node
// Orchestrates all codegen: TypeScript (openapi-typescript + json-schema-to-typescript
// via packages/ts-contracts) then Go/TS proto stubs via `buf generate`.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
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

// buf fails outright on a module with no .proto files, so gate on the files, not
// on the config: codegen starts working by itself once the first .proto lands.
const hasProtos =
  existsSync(protoDir) &&
  readdirSync(protoDir, { recursive: true }).some((f) => String(f).endsWith(".proto"));

if (hasProtos) {
  run("buf", ["generate", "--template", "buf.gen.yaml"], protoDir);
} else {
  console.log("No .proto files under proto/; skipping buf generate.");
}
