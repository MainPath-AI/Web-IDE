package main

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"syscall"
	"time"
)

// The browser resumes a Linux system clock captured in the build snapshot.
// Synchronize in the outer init, before runc drops CAP_SYS_TIME. The fixed
// gateway reaches only the deployment's own Nginx; no external time service,
// browser command, session token, or proxy environment is needed.
const webIDEClockURL = "http://192.168.127.254/"

func newWebIDEClockClient(transport http.RoundTripper) *http.Client {
	if transport == nil {
		transport = &http.Transport{
			Proxy:                 nil,
			DisableKeepAlives:     true,
			ResponseHeaderTimeout: 2 * time.Second,
		}
	}
	return &http.Client{
		Transport: transport,
		Timeout:   2 * time.Second,
		// Even an HTTP redirect must not change the fixed time source.
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
}

func syncWebIDEClock(ctx context.Context, client *http.Client, now func() time.Time, set func(time.Time) error) (bool, error) {
	request, err := http.NewRequestWithContext(ctx, http.MethodHead, webIDEClockURL, nil)
	if err != nil {
		return false, err
	}
	response, err := client.Do(request)
	if err != nil {
		return false, errors.New("deployment clock source is unavailable")
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 400 {
		return false, errors.New("deployment clock source returned an unsuccessful status")
	}
	dates := response.Header.Values("Date")
	if len(dates) != 1 {
		return false, errors.New("deployment clock source must provide one Date header")
	}
	target, err := http.ParseTime(dates[0])
	if err != nil {
		return false, errors.New("deployment clock source returned an invalid Date header")
	}
	difference := target.Sub(now())
	if difference <= 5*time.Second && difference >= -5*time.Second {
		return false, nil
	}
	if err := set(target); err != nil {
		return false, errors.New("updating guest clock failed")
	}
	return true, nil
}

func setWebIDEClock(target time.Time) error {
	// Only CLOCK_REALTIME changes; monotonic timers retain their elapsed time.
	value := syscall.Timeval{Sec: target.Unix()}
	return syscall.Settimeofday(&value)
}

func waitWebIDEClock(ctx context.Context, delay time.Duration) bool {
	timer := time.NewTimer(delay)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-timer.C:
		return true
	}
}

func runWebIDEClockSync(ctx context.Context, client *http.Client, now func() time.Time, set func(time.Time) error, wait func(context.Context, time.Duration) bool) {
	for ctx.Err() == nil {
		changed, err := syncWebIDEClock(ctx, client, now, set)
		delay := 5 * time.Second
		if err == nil {
			delay = 60 * time.Second
			if changed {
				// No HTTP headers, credentials, or raw network errors are logged.
				fmt.Println("WEB_IDE_CLOCK_SYNC")
			}
		}
		if !wait(ctx, delay) {
			return
		}
	}
}

func startWebIDEClockSync() {
	go runWebIDEClockSync(context.Background(), newWebIDEClockClient(nil), time.Now, setWebIDEClock, waitWebIDEClock)
}
