// Package oe has no code of its own. It exists to pin, via blank imports,
// the dependencies that F0.4.T2-T5 need before any package imports them for
// real, so `go mod tidy` run during this task does not drop them.
package oe

import (
	_ "github.com/ClickHouse/clickhouse-go/v2"
	_ "github.com/jackc/pgx/v5"
	_ "github.com/lestrrat-go/jwx/v2/jwk"
	_ "github.com/lestrrat-go/jwx/v2/jwt"
	_ "github.com/nats-io/nats.go"
)
