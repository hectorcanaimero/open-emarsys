// Package natsx publishes and consumes JetStream messages wrapped in the C1
// event envelope: subject "oe.<type>.<tenant_id>", header Nats-Msg-Id = id
// for dedupe, and durable pull consumers with retry-with-backoff and
// dead-lettering after MaxDeliver.
package natsx

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"strings"
	"time"

	"github.com/google/uuid"
	"go.opentelemetry.io/otel/trace"
)

// occurredAtLayout renders occurred_at with exactly millisecond precision,
// as required by contracts/events/envelope.schema.json.
const occurredAtLayout = "2006-01-02T15:04:05.000Z07:00"

// Envelope is the C1 envelope shared by every JetStream message.
type Envelope struct {
	ID            string          `json:"id"`
	Type          string          `json:"type"`
	SchemaVersion int             `json:"schema_version"`
	TenantID      uuid.UUID       `json:"tenant_id"`
	OccurredAt    string          `json:"occurred_at"`
	Source        string          `json:"source"`
	ContactID     *uuid.UUID      `json:"contact_id"`
	TraceParent   string          `json:"trace_parent,omitempty"`
	Data          json.RawMessage `json:"data"`
}

// buildEnvelope assembles a new envelope for an outgoing event: UUID v7 id,
// occurred_at now (UTC, ms precision), source and trace_parent from ctx.
func buildEnvelope(ctx context.Context, source, eventType string, tenantID uuid.UUID, contactID *uuid.UUID, data any) (Envelope, error) {
	id, err := uuid.NewV7()
	if err != nil {
		return Envelope{}, err
	}
	payload, err := json.Marshal(data)
	if err != nil {
		return Envelope{}, err
	}
	return Envelope{
		ID:            id.String(),
		Type:          eventType,
		SchemaVersion: 1,
		TenantID:      tenantID,
		OccurredAt:    time.Now().UTC().Format(occurredAtLayout),
		Source:        source,
		ContactID:     contactID,
		TraceParent:   traceParent(ctx),
		Data:          payload,
	}, nil
}

// traceParent renders the W3C traceparent header (version 00) for the span
// active in ctx, or "" if ctx carries no valid span context.
func traceParent(ctx context.Context) string {
	sc := trace.SpanContextFromContext(ctx)
	if !sc.IsValid() {
		return ""
	}
	flags := "00"
	if sc.IsSampled() {
		flags = "01"
	}
	return "00-" + sc.TraceID().String() + "-" + sc.SpanID().String() + "-" + flags
}

// parseTraceParent parses a W3C traceparent header (version 00) into a
// remote trace.SpanContext. It returns ok=false for "" or a malformed value.
func parseTraceParent(tp string) (sc trace.SpanContext, ok bool) {
	parts := strings.Split(tp, "-")
	if len(parts) != 4 || parts[0] != "00" {
		return trace.SpanContext{}, false
	}
	traceID, err := trace.TraceIDFromHex(parts[1])
	if err != nil {
		return trace.SpanContext{}, false
	}
	spanID, err := trace.SpanIDFromHex(parts[2])
	if err != nil {
		return trace.SpanContext{}, false
	}
	flags, err := hex.DecodeString(parts[3])
	if err != nil || len(flags) != 1 {
		return trace.SpanContext{}, false
	}
	return trace.NewSpanContext(trace.SpanContextConfig{
		TraceID:    traceID,
		SpanID:     spanID,
		TraceFlags: trace.TraceFlags(flags[0]),
		Remote:     true,
	}), true
}
