#!/usr/bin/env node
// Generates src/gen/openapi/<name>.ts from contracts/openapi/**/*.yaml and
// src/gen/events/<name>.ts from contracts/events/*.schema.json. Output is
// gitignored and regenerated here so parallel tasks never fight over it.
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { compileFromFile } from "json-schema-to-typescript";
import openapiTS, { astToString } from "openapi-typescript";

const pkgRoot = fileURLToPath(new URL("..", import.meta.url));
const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
const openapiDir = join(repoRoot, "contracts/openapi");
const eventsDir = join(repoRoot, "contracts/events");
const outOpenapi = join(pkgRoot, "src/gen/openapi");
const outEvents = join(pkgRoot, "src/gen/events");

const list = (dir, re) =>
  existsSync(dir) ? readdirSync(dir, { recursive: true }).filter((f) => re.test(f)).sort() : [];

mkdirSync(outOpenapi, { recursive: true });
mkdirSync(outEvents, { recursive: true });

for (const file of list(openapiDir, /\.ya?ml$/)) {
  const abs = join(openapiDir, file);
  const name = basename(file).replace(/\.ya?ml$/, "");
  const ast = await openapiTS(pathToFileURL(abs));
  writeFileSync(join(outOpenapi, `${name}.ts`), astToString(ast));
  console.log(`generated src/gen/openapi/${name}.ts from ${relative(repoRoot, abs)}`);
}

for (const file of list(eventsDir, /\.schema\.json$/)) {
  const abs = join(eventsDir, file);
  const name = basename(file).replace(/\.schema\.json$/, "");
  const ts = await compileFromFile(abs, { cwd: eventsDir, bannerComment: "" });
  writeFileSync(join(outEvents, `${name}.ts`), ts);
  console.log(`generated src/gen/events/${name}.ts from ${relative(repoRoot, abs)}`);
}
