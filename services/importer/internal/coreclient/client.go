// Package coreclient calls core's internal API (/internal/v1, contract C4) with a
// typ=service token. Callers put tenant_id in the body or query as the contract says.
package coreclient

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/open-emarsys/oe/libs/go/oe/auth"
)

// StatusError is a non-2xx answer; callers retry when Retryable.
type StatusError struct {
	Code int
	Body string
}

func (e *StatusError) Error() string { return fmt.Sprintf("core: status %d: %s", e.Code, e.Body) }

// Retryable reports 5xx and 429, the answers worth a backoff.
func (e *StatusError) Retryable() bool { return e.Code >= 500 || e.Code == http.StatusTooManyRequests }

type Client struct {
	base   string
	tokens *auth.ServiceTokenSource
	http   *http.Client // no overall timeout: the contact stream is long-lived
}

func New(baseURL string, tokens *auth.ServiceTokenSource) *Client {
	return &Client{
		base:   strings.TrimRight(baseURL, "/"),
		tokens: tokens,
		http:   &http.Client{Transport: &http.Transport{ResponseHeaderTimeout: 60 * time.Second, MaxIdleConnsPerHost: 8}},
	}
}

func (c *Client) do(ctx context.Context, method, path string, body io.Reader, accept string) (*http.Response, error) {
	tok, err := c.tokens.Token(ctx)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, method, c.base+path, body)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+tok)
	req.Header.Set("Accept", accept)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode/100 != 2 {
		defer resp.Body.Close()
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 4<<10))
		return nil, &StatusError{Code: resp.StatusCode, Body: string(b)}
	}
	return resp, nil
}

// Post sends in as JSON to path and decodes the JSON answer into out (nil to discard).
// Use it for batch-upsert, lists/{id}/members and relational rows.
func (c *Client) Post(ctx context.Context, path string, in, out any) error {
	raw, err := json.Marshal(in)
	if err != nil {
		return err
	}
	resp, err := c.do(ctx, http.MethodPost, path, bytes.NewReader(raw), "application/json")
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if out == nil {
		_, err = io.Copy(io.Discard, resp.Body)
		return err
	}
	return json.NewDecoder(resp.Body).Decode(out)
}

// StreamContacts opens GET /internal/v1/contacts/stream (NDJSON, one contact per line).
// The caller closes the reader.
func (c *Client) StreamContacts(ctx context.Context, tenantID string, fieldIDs []string) (io.ReadCloser, error) {
	q := url.Values{"tenant_id": {tenantID}, "fields": {strings.Join(fieldIDs, ",")}}
	resp, err := c.do(ctx, http.MethodGet, "/internal/v1/contacts/stream?"+q.Encode(), nil, "application/x-ndjson")
	if err != nil {
		return nil, err
	}
	return resp.Body, nil
}
