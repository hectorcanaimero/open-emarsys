//go:build integration

// Integration test against a real ClickHouse, run with:
//
//	go test -tags integration ./libs/go/oe/chx/...
//
// It needs testcontainers-go and its clickhouse module, which this task
// left out of go.mod (out of scope: "No editar go.mod"). Before running
// this, add and tidy:
//
//	github.com/testcontainers/testcontainers-go
//	github.com/testcontainers/testcontainers-go/modules/clickhouse
package chx_test

import (
	"context"
	"testing"
	"time"

	"github.com/ClickHouse/clickhouse-go/v2"
	"github.com/google/uuid"
	"github.com/testcontainers/testcontainers-go"
	tcclickhouse "github.com/testcontainers/testcontainers-go/modules/clickhouse"

	oechx "github.com/open-emarsys/oe/libs/go/oe/chx"
)

// TestBatcher_FlushesOnSize proves that BatchInsert writes a full flush of
// 10,000 rows to ClickHouse once the buffer reaches maxRows, and that
// Query only counts the rows for the tenant asked for.
func TestBatcher_FlushesOnSize(t *testing.T) {
	ctx := context.Background()

	ctr, err := tcclickhouse.Run(ctx, "clickhouse/clickhouse-server:24.3",
		tcclickhouse.WithDatabase("oe_test"),
		tcclickhouse.WithUsername("oe"),
		tcclickhouse.WithPassword("oe"),
	)
	if err != nil {
		t.Fatalf("start clickhouse container: %v", err)
	}
	t.Cleanup(func() {
		if err := testcontainers.TerminateContainer(ctr); err != nil {
			t.Logf("terminate clickhouse container: %v", err)
		}
	})

	host, err := ctr.ConnectionHost(ctx)
	if err != nil {
		t.Fatalf("connection host: %v", err)
	}

	// DDL setup happens over a plain driver connection: chx.Client only
	// exposes tenant-scoped Query plus BatchInsert, by design.
	ddlConn, err := clickhouse.Open(&clickhouse.Options{
		Addr: []string{host},
		Auth: clickhouse.Auth{Database: "oe_test", Username: "oe", Password: "oe"},
	})
	if err != nil {
		t.Fatalf("ddl conn: %v", err)
	}
	defer ddlConn.Close()
	if err := ddlConn.Exec(ctx, `
		CREATE TABLE events (
			tenant_id UUID,
			id        UInt64,
			name      String
		) ENGINE = MergeTree ORDER BY id
	`); err != nil {
		t.Fatalf("create table: %v", err)
	}

	client, err := oechx.Open(ctx, oechx.Config{
		Addr:     []string{host},
		Database: "oe_test",
		Username: "oe",
		Password: "oe",
	})
	if err != nil {
		t.Fatalf("open client: %v", err)
	}
	defer client.Close()

	const rowCount = 10_000
	tenantID := uuid.New()

	batcher := oechx.NewBatcher(client, rowCount, time.Hour)
	defer batcher.Close(ctx)

	rows := make([][]any, rowCount)
	for i := range rows {
		rows[i] = []any{tenantID, uint64(i), "event"}
	}
	if err := batcher.BatchInsert(ctx, "events", rows); err != nil {
		t.Fatalf("BatchInsert: %v", err)
	}

	result, err := client.Query(ctx,
		`SELECT count() FROM events WHERE tenant_id = {tenant_id:UUID}`,
		clickhouse.Named("tenant_id", tenantID))
	if err != nil {
		t.Fatalf("count query: %v", err)
	}
	defer result.Close()

	if !result.Next() {
		t.Fatal("count query returned no rows")
	}
	var count uint64
	if err := result.Scan(&count); err != nil {
		t.Fatalf("scan count: %v", err)
	}
	if count != rowCount {
		t.Fatalf("count = %d, want %d", count, rowCount)
	}
}
