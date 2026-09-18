package log

import (
	"bytes"
	"context"
	"encoding/json"
	"testing"

	"github.com/google/uuid"
	"go.opentelemetry.io/otel/trace"

	"github.com/open-emarsys/oe/libs/go/oe/tenant"
)

func TestLoggerAddsServiceTenantAndTrace(t *testing.T) {
	var buf bytes.Buffer
	logger := New("hello", &buf)

	tenantID := uuid.New()
	ctx := tenant.WithTenant(context.Background(), tenantID)

	traceID, err := trace.TraceIDFromHex("4bf92f3577b34da6a3ce929d0e0e4736")
	if err != nil {
		t.Fatalf("TraceIDFromHex: %v", err)
	}
	spanID, err := trace.SpanIDFromHex("00f067aa0ba902b7")
	if err != nil {
		t.Fatalf("SpanIDFromHex: %v", err)
	}
	sc := trace.NewSpanContext(trace.SpanContextConfig{
		TraceID:    traceID,
		SpanID:     spanID,
		TraceFlags: trace.FlagsSampled,
	})
	ctx = trace.ContextWithSpanContext(ctx, sc)

	logger.InfoContext(ctx, "hello world")

	var record map[string]any
	if err := json.Unmarshal(buf.Bytes(), &record); err != nil {
		t.Fatalf("unmarshal log line: %v (line: %s)", err, buf.String())
	}

	if record["service"] != "hello" {
		t.Fatalf("service: got %v, want %q", record["service"], "hello")
	}
	if record["tenant_id"] != tenantID.String() {
		t.Fatalf("tenant_id: got %v, want %q", record["tenant_id"], tenantID.String())
	}
	if record["trace_id"] != traceID.String() {
		t.Fatalf("trace_id: got %v, want %q", record["trace_id"], traceID.String())
	}
}

func TestLoggerWithoutContextValues(t *testing.T) {
	var buf bytes.Buffer
	logger := New("hello", &buf)

	logger.InfoContext(context.Background(), "hello world")

	var record map[string]any
	if err := json.Unmarshal(buf.Bytes(), &record); err != nil {
		t.Fatalf("unmarshal log line: %v (line: %s)", err, buf.String())
	}

	if _, ok := record["tenant_id"]; ok {
		t.Fatalf("tenant_id: expected absent, got %v", record["tenant_id"])
	}
	if _, ok := record["trace_id"]; ok {
		t.Fatalf("trace_id: expected absent, got %v", record["trace_id"])
	}
}
