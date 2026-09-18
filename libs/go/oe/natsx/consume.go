package natsx

import (
	"context"
	"encoding/json"
	"fmt"
	"time"

	"github.com/google/uuid"
	"github.com/nats-io/nats.go/jetstream"
	"go.opentelemetry.io/otel/trace"

	"github.com/open-emarsys/oe/libs/go/oe/tenant"
)

// ConsumeOptions tunes the durable consumer created by Consume and
// ConsumeBatch. Zero values fall back to the defaults below.
type ConsumeOptions struct {
	// MaxDeliver caps redelivery attempts; the message is dead-lettered and
	// Term'd once reached. Default 5.
	MaxDeliver int
	// AckWait is how long JetStream waits for an Ack before redelivering,
	// and the max wait for a batch Fetch. Default 30s.
	AckWait time.Duration
	// BackoffBase is the Nak delay after the first failed attempt; each
	// further attempt doubles it, up to BackoffMax. Default 1s.
	BackoffBase time.Duration
	// BackoffMax caps the exponential Nak delay. Default 1m.
	BackoffMax time.Duration
}

const (
	defaultMaxDeliver  = 5
	defaultAckWait     = 30 * time.Second
	defaultBackoffBase = time.Second
	defaultBackoffMax  = time.Minute
)

func (o ConsumeOptions) withDefaults() ConsumeOptions {
	if o.MaxDeliver <= 0 {
		o.MaxDeliver = defaultMaxDeliver
	}
	if o.AckWait <= 0 {
		o.AckWait = defaultAckWait
	}
	if o.BackoffBase <= 0 {
		o.BackoffBase = defaultBackoffBase
	}
	if o.BackoffMax <= 0 {
		o.BackoffMax = defaultBackoffMax
	}
	return o
}

// backoffDelay is the exponential Nak delay for the attempt-th delivery
// (1-indexed), capped at opts.BackoffMax.
func backoffDelay(opts ConsumeOptions, attempt uint64) time.Duration {
	delay := opts.BackoffBase
	for i := uint64(1); i < attempt && delay < opts.BackoffMax; i++ {
		delay *= 2
	}
	if delay > opts.BackoffMax {
		delay = opts.BackoffMax
	}
	return delay
}

// consumer creates or reuses the named durable pull consumer on stream,
// filtered to filterSubject.
func (c *Client) consumer(ctx context.Context, stream, durable, filterSubject string, opts ConsumeOptions) (jetstream.Consumer, error) {
	str, err := c.js.Stream(ctx, stream)
	if err != nil {
		return nil, err
	}
	return str.CreateOrUpdateConsumer(ctx, jetstream.ConsumerConfig{
		Durable:       durable,
		FilterSubject: filterSubject,
		AckPolicy:     jetstream.AckExplicitPolicy,
		MaxDeliver:    opts.MaxDeliver,
		AckWait:       opts.AckWait,
	})
}

func decodeEnvelope(msg jetstream.Msg) (Envelope, error) {
	var env Envelope
	err := json.Unmarshal(msg.Data(), &env)
	return env, err
}

// withEnvelopeContext propagates the envelope's tenant and trace_parent onto
// ctx, for the handler to read via tenant.TenantFrom / trace.SpanContextFromContext.
func withEnvelopeContext(ctx context.Context, env Envelope) context.Context {
	ctx = tenant.WithTenant(ctx, env.TenantID)
	if sc, ok := parseTraceParent(env.TraceParent); ok {
		ctx = trace.ContextWithSpanContext(ctx, sc)
	}
	return ctx
}

// deadLetter republishes msg's raw envelope to oe.system.dead_letter.<tenant>.
func (c *Client) deadLetter(ctx context.Context, msg jetstream.Msg, tenantID uuid.UUID) error {
	_, err := c.js.Publish(ctx, fmt.Sprintf("oe.system.dead_letter.%s", tenantID), msg.Data())
	return err
}

// finish acks msg on success; on failure it Naks with an exponential delay,
// or — once the delivery count reaches opts.MaxDeliver — dead-letters the
// message and Terms it so JetStream stops redelivering.
func (c *Client) finish(ctx context.Context, msg jetstream.Msg, tenantID uuid.UUID, handlerErr error, opts ConsumeOptions) error {
	if handlerErr == nil {
		return msg.Ack()
	}

	meta, err := msg.Metadata()
	if err != nil {
		return msg.Nak()
	}

	if int(meta.NumDelivered) >= opts.MaxDeliver {
		if err := c.deadLetter(ctx, msg, tenantID); err != nil {
			return err
		}
		return msg.Term()
	}

	return msg.NakWithDelay(backoffDelay(opts, meta.NumDelivered))
}

// handle decodes one message, runs handler with tenant/trace propagated onto
// ctx, and resolves the message via finish.
func (c *Client) handle(ctx context.Context, msg jetstream.Msg, opts ConsumeOptions, handler func(context.Context, Envelope) error) {
	env, err := decodeEnvelope(msg)
	if err != nil {
		_ = msg.Term()
		return
	}

	hctx := withEnvelopeContext(ctx, env)
	_ = c.finish(hctx, msg, env.TenantID, handler(hctx, env), opts)
}

// Consume creates or reuses the durable pull consumer named durable on
// stream, filtered to filterSubject, and runs handler for every message
// until ctx is done. The handler's context carries the message's tenant and
// trace_parent. A nil error Acks; an error Naks with exponential backoff,
// or dead-letters and Terms the message once opts.MaxDeliver is reached.
func (c *Client) Consume(ctx context.Context, stream, durable, filterSubject string, handler func(context.Context, Envelope) error, opts ConsumeOptions) error {
	opts = opts.withDefaults()

	cons, err := c.consumer(ctx, stream, durable, filterSubject, opts)
	if err != nil {
		return err
	}

	consumeCtx, err := cons.Consume(func(msg jetstream.Msg) {
		c.handle(ctx, msg, opts, handler)
	})
	if err != nil {
		return err
	}
	defer consumeCtx.Stop()

	<-ctx.Done()
	return ctx.Err()
}

// ConsumeBatch is Consume for sinks that write in bulk: it fetches up to
// batchSize messages at a time (waiting up to opts.AckWait for the first one)
// and calls handler once per non-empty batch. Every message in the batch is
// then resolved via finish using handler's single error, so a batch either
// acks in full or retries/dead-letters message by message.
func (c *Client) ConsumeBatch(ctx context.Context, stream, durable, filterSubject string, batchSize int, handler func(context.Context, []Envelope) error, opts ConsumeOptions) error {
	opts = opts.withDefaults()

	cons, err := c.consumer(ctx, stream, durable, filterSubject, opts)
	if err != nil {
		return err
	}

	for {
		if err := ctx.Err(); err != nil {
			return err
		}

		batch, err := cons.Fetch(batchSize, jetstream.FetchMaxWait(opts.AckWait))
		if err != nil {
			return err
		}

		msgs := make([]jetstream.Msg, 0, batchSize)
		envs := make([]Envelope, 0, batchSize)
		for msg := range batch.Messages() {
			env, err := decodeEnvelope(msg)
			if err != nil {
				_ = msg.Term()
				continue
			}
			msgs = append(msgs, msg)
			envs = append(envs, env)
		}
		if err := batch.Error(); err != nil {
			return err
		}
		if len(envs) == 0 {
			continue
		}

		handlerErr := handler(ctx, envs)
		for i, msg := range msgs {
			_ = c.finish(ctx, msg, envs[i].TenantID, handlerErr, opts)
		}
	}
}
