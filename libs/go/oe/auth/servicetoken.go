package auth

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

// ServiceTokenSource obtains `typ=service` tokens from core for internal
// calls (C4, C5) and renews them before they expire.
//
// Wire format mirrors POST /api/v3/oauth/token: a form body with
// grant_type=client_credentials, client_id and client_secret sent to
// POST /internal/v1/service-token, answered with {access_token, expires_in}.
type ServiceTokenSource struct {
	tokenURL     string
	clientID     string
	clientSecret string
	client       *http.Client
	now          func() time.Time

	mu      sync.Mutex
	token   string
	renewAt time.Time
}

// NewServiceTokenSource returns a source for the core at coreURL.
func NewServiceTokenSource(coreURL, clientID, clientSecret string) *ServiceTokenSource {
	return &ServiceTokenSource{
		tokenURL:     strings.TrimRight(coreURL, "/") + "/internal/v1/service-token",
		clientID:     clientID,
		clientSecret: clientSecret,
		client:       &http.Client{Timeout: 5 * time.Second},
		now:          time.Now,
	}
}

// Token returns a valid service token, fetching a new one once 80% of the
// current one's lifetime has passed.
func (s *ServiceTokenSource) Token(ctx context.Context) (string, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.token != "" && s.now().Before(s.renewAt) {
		return s.token, nil
	}

	form := url.Values{
		"grant_type":    {"client_credentials"},
		"client_id":     {s.clientID},
		"client_secret": {s.clientSecret},
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, s.tokenURL, strings.NewReader(form.Encode()))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	resp, err := s.client.Do(req)
	if err != nil {
		return "", fmt.Errorf("auth: service token: %w", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return "", fmt.Errorf("auth: service token: status %d", resp.StatusCode)
	}
	var body struct {
		AccessToken string `json:"access_token"`
		ExpiresIn   int64  `json:"expires_in"`
	}
	if err := json.NewDecoder(io.LimitReader(resp.Body, 1<<20)).Decode(&body); err != nil {
		return "", fmt.Errorf("auth: service token: %w", err)
	}
	if body.AccessToken == "" || body.ExpiresIn <= 0 {
		return "", errors.New("auth: service token: empty access_token or expires_in")
	}
	ttl := time.Duration(body.ExpiresIn) * time.Second
	s.token = body.AccessToken
	s.renewAt = s.now().Add(ttl - ttl/5)
	return s.token, nil
}
