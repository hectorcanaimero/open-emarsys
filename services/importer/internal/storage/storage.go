// Package storage is the MinIO client: streaming access through the embedded minio.Client
// and presigned URLs signed for the endpoint browsers reach.
package storage

import (
	"context"
	"net/url"
	"time"

	"github.com/minio/minio-go/v7"
	"github.com/minio/minio-go/v7/pkg/credentials"
)

const (
	BucketImports = "imports"
	BucketExports = "exports"
	region        = "us-east-1" // fixed so signing never needs a bucket-location round trip
)

type Config struct {
	Endpoint       string // host:port the service uses
	PublicEndpoint string // host:port callers of presigned URLs use; defaults to Endpoint
	AccessKey      string
	SecretKey      string
	UseSSL         bool
}

type Client struct {
	*minio.Client // object access (GetObject, PutObject with multipart, ...)
	presign       *minio.Client
}

func New(cfg Config) (*Client, error) {
	opts := &minio.Options{Creds: credentials.NewStaticV4(cfg.AccessKey, cfg.SecretKey, ""), Secure: cfg.UseSSL, Region: region}
	c, err := minio.New(cfg.Endpoint, opts)
	if err != nil {
		return nil, err
	}
	p := c
	if cfg.PublicEndpoint != "" && cfg.PublicEndpoint != cfg.Endpoint {
		if p, err = minio.New(cfg.PublicEndpoint, opts); err != nil {
			return nil, err
		}
	}
	return &Client{Client: c, presign: p}, nil
}

// PresignGet returns a download URL for bucket/key valid for expiry.
func (c *Client) PresignGet(ctx context.Context, bucket, key string, expiry time.Duration) (string, error) {
	u, err := c.presign.PresignedGetObject(ctx, bucket, key, expiry, url.Values{})
	if err != nil {
		return "", err
	}
	return u.String(), nil
}

// PresignPut returns an upload URL for bucket/key valid for expiry.
func (c *Client) PresignPut(ctx context.Context, bucket, key string, expiry time.Duration) (string, error) {
	u, err := c.presign.PresignedPutObject(ctx, bucket, key, expiry)
	if err != nil {
		return "", err
	}
	return u.String(), nil
}
