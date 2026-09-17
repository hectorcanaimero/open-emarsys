# Event contracts (C1)

Every JetStream message is a JSON document that matches
[`envelope.schema.json`](envelope.schema.json) (JSON Schema 2020-12), published
with header `Nats-Msg-Id = id` (JetStream dedup window: 2 min).

| field | rule |
|---|---|
| `id` | UUID v7, lowercase |
| `type` | `^[a-z_]+(\.[a-z_]+)+$`, e.g. `contacts.upserted` |
| `schema_version` | integer ≥ 1, version of `data` for this type |
| `tenant_id` | UUID, lowercase |
| `occurred_at` | RFC 3339 with milliseconds, e.g. `2026-09-17T12:34:56.789Z` |
| `source` | emitting service, e.g. `core` |
| `contact_id` | UUID or `null` (required, nullable) |
| `trace_parent` | optional W3C `traceparent` (`00-<trace>-<span>-<flags>`) |
| `data` | object, shape defined per type |

No other top-level fields are allowed.

## Defining an event type

Each event type gets `contracts/events/<type>.schema.json` that extends the
envelope and pins `type` and `data`:

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "title": "ContactsUpserted",
  "allOf": [
    { "$ref": "envelope.schema.json" },
    {
      "properties": {
        "type": { "const": "contacts.upserted" },
        "data": {
          "type": "object",
          "required": ["version", "fields", "changed", "lists"],
          "properties": { "version": { "type": "integer" } }
        }
      }
    }
  ]
}
```

- Reference the envelope by file name (`"$ref": "envelope.schema.json"`); do not set `$id`.
- Put one valid fixture in `contracts/events/examples/<type>.json`. The file name must match the schema name.
- A breaking change to `data` bumps `schema_version` and needs consumers that accept both versions.

## Subjects and streams

Subject: `oe.<type>.<tenant_id>`, e.g. `oe.behavior.tracked.01926f00-0000-7000-8000-000000000001`.

Streams use limits retention, file storage and 1 replica. Durable consumers are named `<service>-<purpose>`.

| stream | subjects |
|---|---|
| `CONTACTS` | `oe.contacts.>`, `oe.consent.>`, `oe.identity.>` |
| `BEHAVIOR` | `oe.behavior.>`, `oe.external_event.>`, `oe.orders.>` |
| `MESSAGES` | `oe.messages.>` |
| `SEGMENTS` | `oe.segments.>` |
| `PROGRAMS` | `oe.programs.>` |
| `CATALOG` | `oe.catalog.>` |
| `ML` | `oe.ml.>` |
| `LOYALTY` | `oe.loyalty.>` |
| `SYSTEM` | `oe.system.>` |

## Validation

```sh
node scripts/codegen/validate-contracts.mjs   # or: make contracts
```

The script checks that every `*.schema.json` compiles, that every example is valid against its schema, and that every `contracts/openapi/**/*.yaml` is a valid OpenAPI 3.1 document. Each error names the file it came from.
