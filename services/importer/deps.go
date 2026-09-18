// Package importer has no code of its own. It pins, via blank imports, the
// dependencies F1.4.T2 and F1.4.T3 need (MinIO, Latin-1 decoding, bounded
// concurrency) so they never touch go.mod/go.sum and `go mod tidy` keeps them.
package importer

import (
	_ "github.com/minio/minio-go/v7"
	_ "golang.org/x/sync/errgroup"
	_ "golang.org/x/text/encoding/charmap"
)
