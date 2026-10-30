package main

import (
	"context"
	"errors"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"
)

type clockRoundTripFunc func(*http.Request) (*http.Response, error)

func (roundTrip clockRoundTripFunc) RoundTrip(request *http.Request) (*http.Response, error) {
	return roundTrip(request)
}

var clockTestTime = time.Date(2026, 10, 30, 14, 0, 0, 0, time.UTC)

func clockResponse(status int, dates ...string) *http.Response {
	return &http.Response{
		StatusCode: status,
		Header:     http.Header{"Date": dates},
		Body:       io.NopCloser(strings.NewReader("")),
	}
}

func TestClockClientIgnoresProxyEnvironmentAndNeverFollowsRedirects(t *testing.T) {
	t.Setenv("HTTP_PROXY", "http://proxy.invalid:1234")
	t.Setenv("http_proxy", "http://proxy.invalid:1234")
	client := newWebIDEClockClient(nil)
	transport, ok := client.Transport.(*http.Transport)
	if !ok || transport.Proxy != nil || !transport.DisableKeepAlives || client.Timeout != 2*time.Second {
		t.Fatal("clock client must use its own bounded transport without environment proxies")
	}
	if client.CheckRedirect(nil, nil) != http.ErrUseLastResponse {
		t.Fatal("clock client must not follow redirects")
	}
}

func TestClockSyncAdjustsOnlyDriftGreaterThanFiveSeconds(t *testing.T) {
	for _, drift := range []time.Duration{-20 * time.Minute, -6 * time.Second, -5 * time.Second, 0, 5 * time.Second, 6 * time.Second, 20 * time.Minute} {
		t.Run(drift.String(), func(t *testing.T) {
			calls := 0
			client := newWebIDEClockClient(clockRoundTripFunc(func(request *http.Request) (*http.Response, error) {
				if request.Method != http.MethodHead || request.URL.String() != webIDEClockURL || request.Body != nil || len(request.Header) != 0 {
					t.Fatal("only a credential-free HEAD to the fixed gateway is permitted")
				}
				return clockResponse(200, clockTestTime.Format(http.TimeFormat)), nil
			}))
			changed, err := syncWebIDEClock(context.Background(), client, func() time.Time { return clockTestTime.Add(drift) }, func(target time.Time) error {
				calls++
				if !target.Equal(clockTestTime) {
					t.Fatal("setter received the wrong deployment time")
				}
				return nil
			})
			want := drift < -5*time.Second || drift > 5*time.Second
			if err != nil || changed != want || (calls == 1) != want {
				t.Fatalf("unexpected adjustment: changed=%v, calls=%d, error=%v", changed, calls, err)
			}
		})
	}
}

func TestClockSyncRejectsInvalidSourcesWithoutCallingSetter(t *testing.T) {
	for _, scenario := range []struct {
		name   string
		status int
		dates  []string
	}{
		{"missing date", 200, nil},
		{"invalid date", 200, []string{"not a date"}},
		{"duplicate date", 200, []string{clockTestTime.Format(http.TimeFormat), clockTestTime.Format(http.TimeFormat)}},
		{"client error", 403, []string{clockTestTime.Format(http.TimeFormat)}},
		{"server error", 503, []string{clockTestTime.Format(http.TimeFormat)}},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			client := newWebIDEClockClient(clockRoundTripFunc(func(*http.Request) (*http.Response, error) {
				return clockResponse(scenario.status, scenario.dates...), nil
			}))
			changed, err := syncWebIDEClock(context.Background(), client, time.Now, func(time.Time) error {
				t.Fatal("invalid source must not alter the clock")
				return nil
			})
			if changed || err == nil {
				t.Fatal("invalid clock source was accepted")
			}
		})
	}
}

func TestClockSyncAcceptsRedirectDateWithoutFollowingLocation(t *testing.T) {
	calls := 0
	client := newWebIDEClockClient(clockRoundTripFunc(func(*http.Request) (*http.Response, error) {
		calls++
		response := clockResponse(302, clockTestTime.Format(http.TimeFormat))
		response.Header.Set("Location", "http://external.invalid/")
		return response, nil
	}))
	changed, err := syncWebIDEClock(context.Background(), client, func() time.Time { return clockTestTime }, func(time.Time) error {
		t.Fatal("already-correct clock must not be changed")
		return nil
	})
	if err != nil || changed || calls != 1 {
		t.Fatal("redirect must be used only as a response from the fixed source")
	}
}

func TestClockSyncReportsSetterFailureAndRetries(t *testing.T) {
	client := newWebIDEClockClient(clockRoundTripFunc(func(*http.Request) (*http.Response, error) {
		return clockResponse(200, clockTestTime.Format(http.TimeFormat)), nil
	}))
	changed, err := syncWebIDEClock(context.Background(), client, func() time.Time { return clockTestTime.Add(-time.Hour) }, func(time.Time) error {
		return errors.New("injected setter failure")
	})
	if changed || err == nil || strings.Contains(err.Error(), "injected") {
		t.Fatal("setter failure must be reported without forwarding raw error details")
	}
}

func TestClockSyncRetriesAfterFiveSecondsThenChecksEveryMinute(t *testing.T) {
	requests := 0
	var delays []time.Duration
	client := newWebIDEClockClient(clockRoundTripFunc(func(*http.Request) (*http.Response, error) {
		requests++
		if requests == 1 {
			return nil, errors.New("injected network failure")
		}
		return clockResponse(200, clockTestTime.Format(http.TimeFormat)), nil
	}))
	runWebIDEClockSync(context.Background(), client, func() time.Time { return clockTestTime }, func(time.Time) error {
		t.Fatal("test never invokes the real or injected setter")
		return nil
	}, func(_ context.Context, delay time.Duration) bool {
		delays = append(delays, delay)
		return len(delays) < 3
	})
	if requests != 3 || len(delays) != 3 || delays[0] != 5*time.Second || delays[1] != time.Minute || delays[2] != time.Minute {
		t.Fatalf("unexpected retry schedule: %v", delays)
	}
}
