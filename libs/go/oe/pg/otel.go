package pg

import (
	"context"

	"github.com/jackc/pgx/v5"
	"go.opentelemetry.io/otel"
	"go.opentelemetry.io/otel/attribute"
	"go.opentelemetry.io/otel/codes"
	"go.opentelemetry.io/otel/trace"
)

const tracerName = "github.com/open-emarsys/oe/libs/go/oe/pg"

type spanCtxKey struct{}

// otelTracer implements pgx.QueryTracer, recording one span per query
// executed through the pool.
type otelTracer struct{}

func (otelTracer) TraceQueryStart(ctx context.Context, _ *pgx.Conn, data pgx.TraceQueryStartData) context.Context {
	ctx, span := otel.Tracer(tracerName).Start(ctx, "pg.query", trace.WithAttributes(
		attribute.String("db.system", "postgresql"),
		attribute.String("db.statement", data.SQL),
	))
	return context.WithValue(ctx, spanCtxKey{}, span)
}

func (otelTracer) TraceQueryEnd(ctx context.Context, _ *pgx.Conn, data pgx.TraceQueryEndData) {
	span, ok := ctx.Value(spanCtxKey{}).(trace.Span)
	if !ok {
		return
	}
	if data.Err != nil {
		span.RecordError(data.Err)
		span.SetStatus(codes.Error, data.Err.Error())
	}
	span.End()
}
