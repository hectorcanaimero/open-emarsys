// Package migrations embeds the importer schema migrations.
package migrations

import "embed"

//go:embed *.sql
var FS embed.FS
