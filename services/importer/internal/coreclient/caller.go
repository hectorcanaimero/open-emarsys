package coreclient

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"strings"
)

// StreamContactsInList is StreamContacts limited to the members of listID.
func (c *Client) StreamContactsInList(ctx context.Context, tenantID string, fieldIDs []string, listID string) (io.ReadCloser, error) {
	q := url.Values{"tenant_id": {tenantID}, "fields": {strings.Join(fieldIDs, ",")}, "list_id": {listID}}
	resp, err := c.do(ctx, http.MethodGet, "/internal/v1/contacts/stream?"+q.Encode(), nil, "application/x-ndjson")
	if err != nil {
		return nil, err
	}
	return resp.Body, nil
}

// GetAs calls a public or admin GET route of core with the caller's own bearer token
// (not the service token), so core answers in the caller's tenant.
func (c *Client) GetAs(ctx context.Context, bearer, path string, out any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.base+path, nil)
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+bearer)
	req.Header.Set("Accept", "application/json")
	resp, err := c.http.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode/100 != 2 {
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 4<<10))
		return &StatusError{Code: resp.StatusCode, Body: string(b)}
	}
	return json.NewDecoder(resp.Body).Decode(out)
}
