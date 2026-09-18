// Package chx wraps the native clickhouse-go/v2 driver with OTel tracing,
// a size/time-triggered batch inserter, and a Query helper that refuses
// SQL not scoped to a tenant.
package chx

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/ClickHouse/clickhouse-go/v2"
	"github.com/ClickHouse/clickhouse-go/v2/lib/driver"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/trace"
)

const tracerName = "github.com/open-emarsys/oe/libs/go/oe/chx"

// tenantPlaceholder is the ClickHouse named-parameter placeholder that
// every Query call must reference, so a query can never accidentally scan
// rows across tenants.
const tenantPlaceholder = "{tenant_id:UUID}"

// ErrMissingTenantParam is returned by Query when its SQL does not
// reference {tenant_id:UUID}.
var ErrMissingTenantParam = errors.New("chx: query must reference " + tenantPlaceholder)

// Config holds the connection parameters for Open.
type Config struct {
	Addr     []string
	Database string
	Username string
	Password string
}

// Client is a native ClickHouse connection instrumented with OTel tracing.
type Client struct {
	conn driver.Conn
}

// Open connects to ClickHouse over the native protocol and pings it.
func Open(ctx context.Context, cfg Config) (*Client, error) {
	conn, err := clickhouse.Open(&clickhouse.Options{
		Addr: cfg.Addr,
		Auth: clickhouse.Auth{
			Database: cfg.Database,
			Username: cfg.Username,
			Password: cfg.Password,
		},
	})
	if err != nil {
		return nil, fmt.Errorf("chx: open: %w", err)
	}
	if err := conn.Ping(ctx); err != nil {
		return nil, fmt.Errorf("chx: ping: %w", err)
	}
	return &Client{conn: conn}, nil
}

// Close closes the underlying connection.
func (c *Client) Close() error {
	return c.conn.Close()
}

// Query runs query, which must reference the {tenant_id:UUID} named
// placeholder (pass it via clickhouse.Named("tenant_id", tenantID)),
// so every read is scoped to a tenant.
func (c *Client) Query(ctx context.Context, query string, args ...any) (driver.Rows, error) {
	if !strings.Contains(query, tenantPlaceholder) {
		return nil, ErrMissingTenantParam
	}
	ctx, span := c.startSpan(ctx, "chx.query", query)
	rows, err := c.conn.Query(ctx, query, args...)
	c.endSpan(span, err)
	return rows, err
}

func (c *Client) startSpan(ctx context.Context, name, statement string) (context.Context, trace.Span) {
	return otel.Tracer(tracerName).Start(ctx, name, trace.WithAttributes(
		attribute.String("db.system", "clickhouse"),
		attribute.String("db.statement", statement),
	))
}

func (c *Client) endSpan(span trace.Span, err error) {
	if err != nil {
		span.RecordError(err)
		span.SetStatus(codes.Error, err.Error())
	}
	span.End()
}
