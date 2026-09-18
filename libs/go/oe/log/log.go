// Package log provides a JSON slog.Logger that tags every record with
// "service", and — when present — "tenant_id" and "trace_id" pulled from
// the context passed to the *Context logging methods (InfoContext, etc.).
package log

import (
	"context"
	"io"
	"log/slog"

	"go.opentelemetry.io/otel/trace"

	"github.com/open-emarsys/oe/libs/go/oe/tenant"
)

// New returns a JSON slog.Logger writing to w, tagged with service.
func New(service string, w io.Writer) *slog.Logger {
	base := slog.NewJSONHandler(w, nil)
	return slog.New(&contextHandler{next: base, service: service})
}

type contextHandler struct {
	next    slog.Handler
	service string
}

func (h *contextHandler) Enabled(ctx context.Context, level slog.Level) bool {
	return h.next.Enabled(ctx, level)
}

func (h *contextHandler) Handle(ctx context.Context, r slog.Record) error {
	r.AddAttrs(slog.String("service", h.service))
	if id, ok := tenant.TenantFrom(ctx); ok {
		r.AddAttrs(slog.String("tenant_id", id.String()))
	}
	if sc := trace.SpanContextFromContext(ctx); sc.HasTraceID() {
		r.AddAttrs(slog.String("trace_id", sc.TraceID().String()))
	}
	return h.next.Handle(ctx, r)
}

func (h *contextHandler) WithAttrs(attrs []slog.Attr) slog.Handler {
	return &contextHandler{next: h.next.WithAttrs(attrs), service: h.service}
}

func (h *contextHandler) WithGroup(name string) slog.Handler {
	return &contextHandler{next: h.next.WithGroup(name), service: h.service}
}
