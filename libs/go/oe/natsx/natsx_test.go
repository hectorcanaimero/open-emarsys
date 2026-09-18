package natsx

import (
	"context"
	"errors"
	"fmt"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/nats-io/nats.go"
	"github.com/nats-io/nats.go/jetstream"
	natstest "github.com/nats-io/nats-server/v2/test"
	"go.opentelemetry.io/otel/sdk/trace"
	otrace "go.opentelemetry.io/otel/trace"
)

// startServer runs an embedded, JetStream-enabled nats-server for the
// duration of the test and returns a connection to it.
func startServer(t *testing.T) *nats.Conn {
	t.Helper()

	opts := natstest.DefaultTestOptions
	opts.Port = -1
	opts.JetStream = true
	opts.StoreDir = t.TempDir()

	srv := natstest.RunServer(&opts)
	t.Cleanup(srv.Shutdown)

	nc, err := nats.Connect(srv.ClientURL())
	if err != nil {
		t.Fatalf("connect: %v", err)
	}
	t.Cleanup(nc.Close)
	return nc
}

// createStream declares a memory-backed test stream covering subjects.
func createStream(t *testing.T, nc *nats.Conn, name string, subjects []string) jetstream.JetStream {
	t.Helper()

	js, err := jetstream.New(nc)
	if err != nil {
		t.Fatalf("jetstream.New: %v", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if _, err := js.CreateStream(ctx, jetstream.StreamConfig{
		Name:     name,
		Subjects: subjects,
		Storage:  jetstream.MemoryStorage,
	}); err != nil {
		t.Fatalf("create stream: %v", err)
	}
	return js
}

func TestPublishDedupesByMsgID(t *testing.T) {
	nc := startServer(t)
	js := createStream(t, nc, "TEST", []string{"oe.>"})

	c, err := New(nc, "svc")
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	ctx := context.Background()
	tenantID := uuid.New()
	id, err := c.Publish(ctx, "widgets.created", tenantID, nil, map[string]string{"k": "v"})
	if err != nil {
		t.Fatalf("Publish: %v", err)
	}

	// Simulate the producer retrying the same publish: same Nats-Msg-Id.
	dup := &nats.Msg{
		Subject: fmt.Sprintf("oe.widgets.created.%s", tenantID),
		Data:    []byte(`{"retry":true}`),
		Header:  nats.Header{"Nats-Msg-Id": []string{id}},
	}
	ack, err := js.PublishMsg(ctx, dup)
	if err != nil {
		t.Fatalf("publish duplicate: %v", err)
	}
	if !ack.Duplicate {
		t.Fatalf("expected the retried publish to be flagged as a duplicate, got %+v", ack)
	}

	str, err := js.Stream(ctx, "TEST")
	if err != nil {
		t.Fatalf("stream: %v", err)
	}
	info, err := str.Info(ctx)
	if err != nil {
		t.Fatalf("stream info: %v", err)
	}
	if info.State.Msgs != 1 {
		t.Fatalf("expected 1 stored message after the duplicate publish, got %d", info.State.Msgs)
	}
}

func TestConsumeRetriesWithNakThenAcks(t *testing.T) {
	nc := startServer(t)
	_ = createStream(t, nc, "TEST", []string{"oe.>"})

	c, err := New(nc, "svc")
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	ctx := context.Background()
	tenantID := uuid.New()
	if _, err := c.Publish(ctx, "widgets.created", tenantID, nil, map[string]string{"k": "v"}); err != nil {
		t.Fatalf("Publish: %v", err)
	}

	var attempts int32
	done := make(chan struct{})
	cctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	go func() {
		_ = c.Consume(cctx, "TEST", "svc-retry", "oe.widgets.created.>", func(_ context.Context, _ Envelope) error {
			if atomic.AddInt32(&attempts, 1) < 3 {
				return errors.New("boom")
			}
			close(done)
			return nil
		}, ConsumeOptions{
			MaxDeliver:  5,
			AckWait:     2 * time.Second,
			BackoffBase: 10 * time.Millisecond,
			BackoffMax:  50 * time.Millisecond,
		})
	}()

	select {
	case <-done:
	case <-time.After(10 * time.Second):
		t.Fatal("timed out waiting for the handler to eventually succeed")
	}

	if got := atomic.LoadInt32(&attempts); got != 3 {
		t.Fatalf("expected exactly 3 delivery attempts before success, got %d", got)
	}
}

func TestConsumeDeadLettersAfterMaxDeliver(t *testing.T) {
	nc := startServer(t)
	_ = createStream(t, nc, "TEST", []string{"oe.>"})

	c, err := New(nc, "svc")
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	ctx := context.Background()
	tenantID := uuid.New()
	if _, err := c.Publish(ctx, "widgets.created", tenantID, nil, map[string]string{"k": "v"}); err != nil {
		t.Fatalf("Publish: %v", err)
	}

	dlSub, err := nc.SubscribeSync("oe.system.dead_letter.>")
	if err != nil {
		t.Fatalf("subscribe dead letter: %v", err)
	}
	defer func() { _ = dlSub.Unsubscribe() }()

	var attempts int32
	cctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	go func() {
		_ = c.Consume(cctx, "TEST", "svc-deadletter", "oe.widgets.created.>", func(_ context.Context, _ Envelope) error {
			atomic.AddInt32(&attempts, 1)
			return errors.New("always fails")
		}, ConsumeOptions{
			MaxDeliver:  3,
			AckWait:     2 * time.Second,
			BackoffBase: 5 * time.Millisecond,
			BackoffMax:  20 * time.Millisecond,
		})
	}()

	dl, err := dlSub.NextMsg(10 * time.Second)
	if err != nil {
		t.Fatalf("expected a dead-lettered message, got: %v", err)
	}
	wantSubject := fmt.Sprintf("oe.system.dead_letter.%s", tenantID)
	if dl.Subject != wantSubject {
		t.Fatalf("dead letter subject = %q, want %q", dl.Subject, wantSubject)
	}

	if got := atomic.LoadInt32(&attempts); int(got) != 3 {
		t.Fatalf("expected 3 delivery attempts (= MaxDeliver) before dead-lettering, got %d", got)
	}
}

func TestConsumePropagatesTraceParent(t *testing.T) {
	nc := startServer(t)
	_ = createStream(t, nc, "TEST", []string{"oe.>"})

	c, err := New(nc, "svc")
	if err != nil {
		t.Fatalf("New: %v", err)
	}

	tp := trace.NewTracerProvider(trace.WithSampler(trace.AlwaysSample()))
	defer func() { _ = tp.Shutdown(context.Background()) }()

	spanCtx, span := tp.Tracer("test").Start(context.Background(), "publish")
	wantTraceID := span.SpanContext().TraceID().String()

	tenantID := uuid.New()
	if _, err := c.Publish(spanCtx, "widgets.created", tenantID, nil, map[string]string{"k": "v"}); err != nil {
		t.Fatalf("Publish: %v", err)
	}
	span.End()

	var gotTraceID string
	done := make(chan struct{})
	cctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	go func() {
		_ = c.Consume(cctx, "TEST", "svc-trace", "oe.widgets.created.>", func(hctx context.Context, _ Envelope) error {
			gotTraceID = otrace.SpanContextFromContext(hctx).TraceID().String()
			close(done)
			return nil
		}, ConsumeOptions{})
	}()

	select {
	case <-done:
	case <-time.After(10 * time.Second):
		t.Fatal("timed out waiting for the message to be consumed")
	}

	if gotTraceID != wantTraceID {
		t.Fatalf("trace id propagated to handler = %q, want %q", gotTraceID, wantTraceID)
	}
}
