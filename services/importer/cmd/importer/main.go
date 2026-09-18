// Command importer runs the import/export job service.
package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/nats-io/nats.go"

	"github.com/open-emarsys/oe/libs/go/oe/auth"
	"github.com/open-emarsys/oe/libs/go/oe/config"
	"github.com/open-emarsys/oe/libs/go/oe/httpx"
	oelog "github.com/open-emarsys/oe/libs/go/oe/log"
	"github.com/open-emarsys/oe/libs/go/oe/natsx"
	oeotel "github.com/open-emarsys/oe/libs/go/oe/otel"
	"github.com/open-emarsys/oe/libs/go/oe/pg"
	"github.com/open-emarsys/oe/services/importer/internal/coreclient"
	"github.com/open-emarsys/oe/services/importer/internal/exports"
	"github.com/open-emarsys/oe/services/importer/internal/imports"
	"github.com/open-emarsys/oe/services/importer/internal/jobs"
	"github.com/open-emarsys/oe/services/importer/internal/storage"
	"github.com/open-emarsys/oe/services/importer/migrations"
)

const serviceName = "importer"

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	logger := oelog.New(serviceName, os.Stdout)
	if err := run(ctx, logger); err != nil {
		logger.ErrorContext(ctx, "importer stopped", "error", err)
		os.Exit(1)
	}
}

func run(ctx context.Context, logger *slog.Logger) error {
	shutdownOtel, err := oeotel.Setup(ctx, serviceName)
	if err != nil {
		return err
	}
	defer func() { _ = shutdownOtel(context.Background()) }()

	cfg := config.New("IMPORTER")
	dsn, err := cfg.MustString("DATABASE_URL")
	if err != nil {
		return err
	}
	coreURL, err := cfg.MustString("CORE_URL")
	if err != nil {
		return err
	}
	secret, err := cfg.MustString("SERVICE_SECRET")
	if err != nil {
		return err
	}
	minioSecret, err := cfg.MustString("MINIO_SECRET_KEY")
	if err != nil {
		return err
	}

	pool, err := pg.NewPool(ctx, dsn)
	if err != nil {
		return err
	}
	defer pool.Close()
	if err := pg.Migrate(ctx, pool, "importer", migrations.FS); err != nil {
		return err
	}

	store, err := storage.New(storage.Config{
		Endpoint:       cfg.String("MINIO_ENDPOINT", "minio:9000"),
		PublicEndpoint: cfg.String("MINIO_PUBLIC_ENDPOINT", ""),
		AccessKey:      cfg.String("MINIO_ACCESS_KEY", "oe_minio"),
		SecretKey:      minioSecret,
		UseSSL:         cfg.Bool("MINIO_USE_SSL", false),
	})
	if err != nil {
		return err
	}

	// Keep retrying if NATS is still starting; a publish that cannot reach it only logs.
	nc, err := nats.Connect(cfg.String("NATS_URL", "nats://nats:4222"), nats.RetryOnFailedConnect(true), nats.MaxReconnects(-1))
	if err != nil {
		return err
	}
	defer nc.Close()
	events, err := natsx.New(nc, serviceName)
	if err != nil {
		return err
	}

	tokens := auth.NewServiceTokenSource(coreURL, serviceName, secret)
	jobStore := jobs.NewStore(pool)
	env := &jobs.Env{
		Store: jobStore,
		Queue: jobs.NewQueue(jobStore, logger, jobs.Options{
			Workers:       cfg.Int("WORKERS", 2),
			ProgressEvery: cfg.Duration("PROGRESS_INTERVAL", 5*time.Second),
			Stale:         cfg.Duration("ORPHAN_AFTER", 0),
			MaxAttempts:   cfg.Int("MAX_ATTEMPTS", 3),
		}),
		Storage:    store,
		Core:       coreclient.New(coreURL, tokens),
		CoreURL:    coreURL,
		CoreTokens: tokens,
		Verifier:   auth.NewVerifier(coreURL),
		Events:     events,
	}

	mux := http.NewServeMux()
	mux.HandleFunc("/healthz", httpx.Healthz)
	mux.HandleFunc("/readyz", httpx.Readyz(func(ctx context.Context) error { return pool.Ping(ctx) }))
	jobs.Routes(mux, jobStore, env.Verifier)
	imports.Register(mux, env)
	exports.Register(mux, env)

	queueDone := make(chan struct{})
	go func() { env.Queue.Run(ctx); close(queueDone) }()
	defer func() { <-queueDone }()

	addr := cfg.String("ADDR", ":8080")
	srv := httpx.NewServer(addr, mux, serviceName, logger)
	go func() {
		<-ctx.Done()
		sctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		_ = srv.Shutdown(sctx)
	}()
	logger.InfoContext(ctx, "starting", "addr", addr)
	if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}
