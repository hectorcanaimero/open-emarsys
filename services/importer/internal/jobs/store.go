// Package jobs is the Postgres-backed job queue and the read API over importer.jobs.
package jobs

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/open-emarsys/oe/libs/go/oe/pg"
	"github.com/open-emarsys/oe/libs/go/oe/tenant"
)

const (
	StatusQueued    = "queued"
	StatusRunning   = "running"
	StatusSucceeded = "succeeded"
	StatusFailed    = "failed"
	StatusCancelled = "cancelled"
)

var ErrNotFound = errors.New("jobs: not found")

// Progress is persisted in jobs.progress. Percent is 0-100.
type Progress struct {
	RowsRead   int64   `json:"rows_read"`
	RowsOK     int64   `json:"rows_ok"`
	RowsFailed int64   `json:"rows_failed"`
	Percent    float64 `json:"percent"`
}

type Job struct {
	ID             uuid.UUID       `json:"id"`
	TenantID       uuid.UUID       `json:"tenant_id"`
	Kind           string          `json:"kind"`
	Status         string          `json:"status"`
	Params         json.RawMessage `json:"params"`
	Progress       Progress        `json:"progress"`
	ResultURL      *string         `json:"result_url"`
	ErrorReportURL *string         `json:"error_report_url"`
	Error          *string         `json:"error"`
	Attempts       int             `json:"attempts"`
	CreatedBy      string          `json:"created_by"`
	CreatedAt      time.Time       `json:"created_at"`
	FinishedAt     *time.Time      `json:"finished_at"`
}

type Store struct{ pool *pgxpool.Pool }

func NewStore(pool *pgxpool.Pool) *Store { return &Store{pool: pool} }

const cols = `id, tenant_id, kind, status, params, progress, result_url, error_report_url,
	error, attempts, created_by, created_at, finished_at`

func scan(row pgx.Row) (*Job, error) {
	var j Job
	var progress []byte
	err := row.Scan(&j.ID, &j.TenantID, &j.Kind, &j.Status, &j.Params, &progress, &j.ResultURL,
		&j.ErrorReportURL, &j.Error, &j.Attempts, &j.CreatedBy, &j.CreatedAt, &j.FinishedAt)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return &j, json.Unmarshal(progress, &j.Progress)
}

// Enqueue creates a queued job for the tenant in ctx.
func (s *Store) Enqueue(ctx context.Context, kind string, params any, createdBy string) (uuid.UUID, error) {
	tid, ok := tenant.TenantFrom(ctx)
	if !ok {
		return uuid.Nil, pg.ErrNoTenant
	}
	raw, err := json.Marshal(params)
	if err != nil {
		return uuid.Nil, err
	}
	id, err := uuid.NewV7()
	if err != nil {
		return uuid.Nil, err
	}
	err = pg.InTenantTx(ctx, s.pool, func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `INSERT INTO importer.jobs (id, tenant_id, kind, params, created_by)
			VALUES ($1, $2, $3, $4, $5)`, id, tid, kind, raw, createdBy)
		return err
	})
	return id, err
}

// Get returns a job of the tenant in ctx; another tenant's job is ErrNotFound (RLS).
func (s *Store) Get(ctx context.Context, id uuid.UUID) (*Job, error) {
	var j *Job
	err := pg.InTenantTx(ctx, s.pool, func(tx pgx.Tx) error {
		var err error
		j, err = scan(tx.QueryRow(ctx, `SELECT `+cols+` FROM importer.jobs WHERE id = $1`, id))
		return err
	})
	return j, err
}

// List pages the tenant's jobs newest first. The cursor is opaque; next is "" on the last page.
func (s *Store) List(ctx context.Context, cursor string, limit int) (items []*Job, next string, err error) {
	at, after := time.Now().Add(24*time.Hour), uuid.Max
	if cursor != "" {
		if at, after, err = decodeCursor(cursor); err != nil {
			return nil, "", fmt.Errorf("jobs: invalid cursor")
		}
	}
	err = pg.InTenantTx(ctx, s.pool, func(tx pgx.Tx) error {
		rows, err := tx.Query(ctx, `SELECT `+cols+` FROM importer.jobs
			WHERE (created_at, id) < ($1, $2) ORDER BY created_at DESC, id DESC LIMIT $3`, at, after, limit+1)
		if err != nil {
			return err
		}
		defer rows.Close()
		for rows.Next() {
			j, err := scan(rows)
			if err != nil {
				return err
			}
			items = append(items, j)
		}
		return rows.Err()
	})
	if err == nil && len(items) > limit {
		items = items[:limit]
		last := items[limit-1]
		next = base64.RawURLEncoding.EncodeToString([]byte(last.CreatedAt.Format(time.RFC3339Nano) + "|" + last.ID.String()))
	}
	return items, next, err
}

func decodeCursor(c string) (time.Time, uuid.UUID, error) {
	raw, err := base64.RawURLEncoding.DecodeString(c)
	if err != nil {
		return time.Time{}, uuid.Nil, err
	}
	ts, id, ok := strings.Cut(string(raw), "|")
	if !ok {
		return time.Time{}, uuid.Nil, errors.New("bad cursor")
	}
	t, err := time.Parse(time.RFC3339Nano, ts)
	if err != nil {
		return time.Time{}, uuid.Nil, err
	}
	u, err := uuid.Parse(id)
	return t, u, err
}

// sysTx runs fn across tenants (queue internals only): it sets app.system for the jobs_system policy.
func (s *Store) sysTx(ctx context.Context, fn func(pgx.Tx) error) error {
	return pg.InSystemTx(ctx, s.pool, func(tx pgx.Tx) error {
		if _, err := tx.Exec(ctx, `SELECT set_config('app.system', 'on', true)`); err != nil {
			return err
		}
		return fn(tx)
	})
}

// claim takes the oldest queued job, or returns (nil, nil) when there is none.
func (s *Store) claim(ctx context.Context) (*Job, error) {
	var j *Job
	err := s.sysTx(ctx, func(tx pgx.Tx) error {
		var err error
		j, err = scan(tx.QueryRow(ctx, `UPDATE importer.jobs
			SET status = 'running', attempts = attempts + 1, heartbeat_at = now()
			WHERE id = (SELECT id FROM importer.jobs WHERE status = 'queued'
				ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1)
			RETURNING `+cols))
		return err
	})
	if errors.Is(err, ErrNotFound) {
		return nil, nil
	}
	return j, err
}

// saveProgress persists progress and refreshes the heartbeat that keeps the job from looking orphaned.
func (s *Store) saveProgress(ctx context.Context, id uuid.UUID, p Progress) error {
	raw, _ := json.Marshal(p)
	return s.sysTx(ctx, func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `UPDATE importer.jobs SET progress = $2, heartbeat_at = now()
			WHERE id = $1 AND status = 'running'`, id, raw)
		return err
	})
}

func (s *Store) finish(ctx context.Context, id uuid.UUID, status string, p Progress, out Outcome, errText string) error {
	raw, _ := json.Marshal(p)
	return s.sysTx(ctx, func(tx pgx.Tx) error {
		_, err := tx.Exec(ctx, `UPDATE importer.jobs SET status = $2, progress = $3, result_url = $4,
			error_report_url = $5, error = nullif($6, ''), finished_at = now() WHERE id = $1`,
			id, status, raw, nullable(out.ResultURL), nullable(out.ErrorReportURL), errText)
		return err
	})
}

func nullable(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

// requeueOrphans puts running jobs whose heartbeat is older than stale back in the queue,
// or fails them once they have used maxAttempts. It returns how many it touched.
func (s *Store) requeueOrphans(ctx context.Context, stale time.Duration, maxAttempts int) (n int64, err error) {
	err = s.sysTx(ctx, func(tx pgx.Tx) error {
		tag, err := tx.Exec(ctx, `UPDATE importer.jobs
			SET status = CASE WHEN attempts >= $2 THEN 'failed' ELSE 'queued' END,
			    error = CASE WHEN attempts >= $2 THEN 'worker lost; retries exhausted' ELSE error END,
			    finished_at = CASE WHEN attempts >= $2 THEN now() ELSE finished_at END
			WHERE status = 'running' AND heartbeat_at < now() - make_interval(secs => $1)`,
			stale.Seconds(), maxAttempts)
		n = tag.RowsAffected()
		return err
	})
	return n, err
}
