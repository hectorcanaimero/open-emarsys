#!/usr/bin/env node
// Validates contracts/: every event schema compiles, every example validates
// against its schema, every OpenAPI document is valid 3.1. Exits 1 on any error.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import SwaggerParser from "@apidevtools/swagger-parser";

const root = fileURLToPath(new URL("../..", import.meta.url));
const eventsDir = join(root, "contracts/events");
const examplesDir = join(eventsDir, "examples");
const openapiDir = join(root, "contracts/openapi");

const errors = [];
const fail = (file, msg) => errors.push(`${relative(root, file)}: ${msg}`);
const list = (dir, re) =>
  existsSync(dir) ? readdirSync(dir, { recursive: true }).filter((f) => re.test(f)).sort() : [];
const readJson = (file) => {
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    fail(file, `invalid JSON: ${e.message}`);
  }
};

// Schemas are registered by file name so `{"$ref": "envelope.schema.json"}` resolves.
const ajv = new Ajv2020({ allErrors: true, strict: true });
addFormats(ajv);
const schemaFiles = readdirSync(eventsDir).filter((f) => f.endsWith(".schema.json")).sort();
const loaded = [];
for (const name of schemaFiles) {
  const schema = readJson(join(eventsDir, name));
  if (!schema) continue;
  try {
    ajv.addSchema(schema, name);
    loaded.push(name);
  } catch (e) {
    fail(join(eventsDir, name), e.message);
  }
}
const validators = new Map();
for (const name of loaded) {
  try {
    validators.set(name, ajv.getSchema(name));
  } catch (e) {
    fail(join(eventsDir, name), `does not compile: ${e.message}`);
  }
}

for (const name of list(examplesDir, /\.json$/)) {
  const file = join(examplesDir, name);
  const schemaName = name.replace(/\.json$/, ".schema.json");
  if (!schemaFiles.includes(schemaName)) {
    fail(file, `no schema contracts/events/${schemaName}`);
    continue;
  }
  const validate = validators.get(schemaName);
  const example = readJson(file);
  if (!validate || example === undefined) continue;
  if (!validate(example)) {
    for (const err of validate.errors) {
      fail(file, `${err.instancePath || "/"} ${err.message} (${schemaName}${err.schemaPath})`);
    }
  }
}

// contracts/dsl/<name>.json validates against its sibling <name>.schema.json.
const dslDir = join(root, "contracts/dsl");
for (const name of list(dslDir, /(?<!\.schema)\.json$/)) {
  const file = join(dslDir, name);
  const schemaFile = join(dslDir, name.replace(/\.json$/, ".schema.json"));
  if (!existsSync(schemaFile)) {
    fail(file, `no schema ${relative(root, schemaFile)}`);
    continue;
  }
  const schema = readJson(schemaFile);
  const doc = readJson(file);
  if (!schema || doc === undefined) continue;
  let validate;
  try {
    validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
  } catch (e) {
    fail(schemaFile, `does not compile: ${e.message}`);
    continue;
  }
  if (!validate(doc)) {
    for (const err of validate.errors) fail(file, `${err.instancePath || "/"} ${err.message}`);
  }
}

// JSON Schema cannot say "field_id/api_name unique across items".
const systemFields = join(dslDir, "system-fields.json");
if (existsSync(systemFields)) {
  const fields = readJson(systemFields) ?? [];
  for (const key of ["field_id", "api_name"]) {
    const seen = new Set();
    for (const f of fields) {
      if (seen.has(f[key])) fail(systemFields, `duplicate ${key} ${f[key]}`);
      seen.add(f[key]);
    }
  }
}

for (const name of list(openapiDir, /\.ya?ml$/)) {
  const file = join(openapiDir, name);
  try {
    const api = await SwaggerParser.validate(file);
    if (!/^3\.1\.\d+$/.test(api.openapi ?? "")) fail(file, `openapi must be 3.1.x, got ${api.openapi ?? api.swagger}`);
  } catch (e) {
    fail(file, e.message);
  }
}

if (errors.length) {
  console.error(`contracts: ${errors.length} error(s)\n${errors.join("\n")}`);
  process.exit(1);
}
console.log(
  `contracts: ok (${schemaFiles.length} schemas, ${list(examplesDir, /\.json$/).length} examples, ${list(openapiDir, /\.ya?ml$/).length} openapi)`,
);
