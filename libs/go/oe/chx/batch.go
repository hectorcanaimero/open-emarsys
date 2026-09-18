package chx

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"time"
)

// Batcher buffers rows per table and flushes them via a native ClickHouse
// batch insert, either once a table's buffer reaches maxRows rows or every
// flushEvery, whichever happens first.
type Batcher struct {
	client     *Client
	maxRows    int
	flushEvery time.Duration

	mu      sync.Mutex
	buffers map[string][][]any

	stopOnce sync.Once
	stopCh   chan struct{}
	doneCh   chan struct{}
}

// NewBatcher starts a Batcher backed by client. Callers must call Close to
// flush any buffered rows and stop the background time-based flush.
func NewBatcher(client *Client, maxRows int, flushEvery time.Duration) *Batcher {
	b := &Batcher{
		client:     client,
		maxRows:    maxRows,
		flushEvery: flushEvery,
		buffers:    make(map[string][][]any),
		stopCh:     make(chan struct{}),
		doneCh:     make(chan struct{}),
	}
	go b.loop()
	return b
}

func (b *Batcher) loop() {
	defer close(b.doneCh)
	t := time.NewTicker(b.flushEvery)
	defer t.Stop()
	for {
		select {
		case <-t.C:
			_ = b.FlushAll(context.Background())
		case <-b.stopCh:
			return
		}
	}
}

// BatchInsert appends rows to table's buffer and flushes it immediately if
// it now holds at least maxRows rows.
func (b *Batcher) BatchInsert(ctx context.Context, table string, rows [][]any) error {
	b.mu.Lock()
	b.buffers[table] = append(b.buffers[table], rows...)
	full := len(b.buffers[table]) >= b.maxRows
	b.mu.Unlock()

	if full {
		return b.Flush(ctx, table)
	}
	return nil
}

// Flush writes and clears every row currently buffered for table.
func (b *Batcher) Flush(ctx context.Context, table string) error {
	b.mu.Lock()
	rows := b.buffers[table]
	b.buffers[table] = nil
	b.mu.Unlock()

	if len(rows) == 0 {
		return nil
	}

	ctx, span := b.client.startSpan(ctx, "chx.batch_insert", "INSERT INTO "+table)
	err := b.insert(ctx, table, rows)
	b.client.endSpan(span, err)
	return err
}

func (b *Batcher) insert(ctx context.Context, table string, rows [][]any) error {
	batch, err := b.client.conn.PrepareBatch(ctx, "INSERT INTO "+table)
	if err != nil {
		return fmt.Errorf("chx: prepare batch: %w", err)
	}
	for _, row := range rows {
		if err := batch.Append(row...); err != nil {
			return fmt.Errorf("chx: append row: %w", err)
		}
	}
	if err := batch.Send(); err != nil {
		return fmt.Errorf("chx: send batch: %w", err)
	}
	return nil
}

// FlushAll flushes every table with buffered rows, joining any errors.
func (b *Batcher) FlushAll(ctx context.Context) error {
	b.mu.Lock()
	tables := make([]string, 0, len(b.buffers))
	for table, rows := range b.buffers {
		if len(rows) > 0 {
			tables = append(tables, table)
		}
	}
	b.mu.Unlock()

	var errs []error
	for _, table := range tables {
		if err := b.Flush(ctx, table); err != nil {
			errs = append(errs, err)
		}
	}
	return errors.Join(errs...)
}

// Close stops the background flush loop and flushes any rows still
// buffered.
func (b *Batcher) Close(ctx context.Context) error {
	b.stopOnce.Do(func() { close(b.stopCh) })
	<-b.doneCh
	return b.FlushAll(ctx)
}
