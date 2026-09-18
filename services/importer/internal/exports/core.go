package exports

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"github.com/google/uuid"

	"github.com/open-emarsys/oe/libs/go/oe/auth"
)

type choice struct {
	ID     int               `json:"id"`
	Labels map[string]string `json:"labels"`
}

type field struct {
	FieldID int      `json:"field_id"`
	APIName string   `json:"api_name"`
	Type    string   `json:"type"`
	Choices []choice `json:"choices"`
}

// fieldMeta is the answer of GET /internal/v1/fields.
type fieldMeta struct {
	DefaultLocale string  `json:"default_locale"`
	Fields        []field `json:"fields"`
}

// coreAPI is the slice of core's internal API (C4) that exports need: field metadata and the
// contact stream with an optional list filter, which coreclient does not expose.
type coreAPI struct {
	base   string
	tokens *auth.ServiceTokenSource
	http   *http.Client // no overall timeout: the contact stream is long-lived
}

func newCoreAPI(base string, tokens *auth.ServiceTokenSource) *coreAPI {
	return &coreAPI{
		base:   strings.TrimRight(base, "/"),
		tokens: tokens,
		http:   &http.Client{Transport: &http.Transport{ResponseHeaderTimeout: 60 * time.Second}},
	}
}

func (c *coreAPI) get(ctx context.Context, path string, q url.Values, accept string) (io.ReadCloser, error) {
	tok, err := c.tokens.Token(ctx)
	if err != nil {
		return nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.base+path+"?"+q.Encode(), nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+tok)
	req.Header.Set("Accept", accept)
	resp, err := c.http.Do(req)
	if err != nil {
		return nil, err
	}
	if resp.StatusCode/100 != 2 {
		defer resp.Body.Close()
		b, _ := io.ReadAll(io.LimitReader(resp.Body, 4<<10))
		return nil, fmt.Errorf("core: status %d: %s", resp.StatusCode, b)
	}
	return resp.Body, nil
}

func (c *coreAPI) fields(ctx context.Context, tenantID uuid.UUID) (fieldMeta, error) {
	body, err := c.get(ctx, "/internal/v1/fields", url.Values{"tenant_id": {tenantID.String()}}, "application/json")
	if err != nil {
		return fieldMeta{}, err
	}
	defer body.Close()
	var m fieldMeta
	return m, json.NewDecoder(body).Decode(&m)
}

// stream opens the NDJSON contact stream; listID "" means every contact.
func (c *coreAPI) stream(ctx context.Context, tenantID uuid.UUID, ids []int, listID string) (io.ReadCloser, error) {
	s := make([]string, len(ids))
	for i, id := range ids {
		s[i] = strconv.Itoa(id)
	}
	q := url.Values{"tenant_id": {tenantID.String()}, "fields": {strings.Join(s, ",")}}
	if listID != "" {
		q.Set("list_id", listID)
	}
	return c.get(ctx, "/internal/v1/contacts/stream", q, "application/x-ndjson")
}
