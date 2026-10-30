package main

import (
	"bytes"
	"context"
	"encoding/binary"
	"flag"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"golang.org/x/net/websocket"
)

const tokenA = "0123456789abcdef0123456789abcdef"
const tokenB = "fedcba9876543210fedcba9876543210"

// startWorker launches this same test executable in its real worker mode,
// exercising inherited listeners and gVisor without building another binary.
var testWorkerFD = flag.Int("worker-fd", 0, "internal test worker listener")
var testWorkerIdle = flag.Duration("idle-timeout", time.Minute, "internal test worker idle timeout")

func TestMain(m *testing.M) {
	flag.Parse()
	if *testWorkerFD != 0 {
		if err := serveWorker(*testWorkerFD, *testWorkerIdle); err != nil {
			fmt.Fprintln(os.Stderr, "test network worker failed:", err)
			os.Exit(1)
		}
		os.Exit(0)
	}
	os.Exit(m.Run())
}

func TestRealWorkerWebSocketCarriesQemuARPAndCleansUp(t *testing.T) {
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	b := newBridge(2, time.Minute, func() (*backend, error) { return startWorker(executable, 10*time.Second) })
	server := httptest.NewServer(b)
	defer server.Close()
	defer b.close()
	config, err := websocket.NewConfig("ws"+strings.TrimPrefix(server.URL, "http")+"/sessions/"+tokenA+"/net", server.URL)
	if err != nil {
		t.Fatal(err)
	}
	config.Protocol = []string{"binary"}
	config.Dialer = &net.Dialer{Timeout: 5 * time.Second}
	conn, err := websocket.DialConfig(config)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	conn.PayloadType = websocket.BinaryFrame
	if len(conn.Config().Protocol) != 1 || conn.Config().Protocol[0] != "binary" {
		t.Fatal("binary subprotocol was not preserved")
	}
	_ = conn.SetDeadline(time.Now().Add(5 * time.Second))
	// Real QEMU network framing (4-byte big-endian length), followed by an
	// Ethernet ARP request from the fixed guest address to its private gateway.
	packet := []byte{
		255, 255, 255, 255, 255, 255, 2, 0, 0, 0, 0, 1, 8, 6,
		0, 1, 8, 0, 6, 4, 0, 1,
		2, 0, 0, 0, 0, 1, 192, 168, 127, 3,
		0, 0, 0, 0, 0, 0, 192, 168, 127, 1,
	}
	frame := make([]byte, 4+len(packet))
	binary.BigEndian.PutUint32(frame, uint32(len(packet)))
	copy(frame[4:], packet)
	if _, err := conn.Write(frame); err != nil {
		t.Fatal(err)
	}
	var length [4]byte
	if _, err := io.ReadFull(conn, length[:]); err != nil {
		t.Fatalf("worker closed before a real QEMU ARP reply: %v", err)
	}
	size := binary.BigEndian.Uint32(length[:])
	if size < 42 || size > 1500 {
		t.Fatalf("invalid QEMU reply length: %d", size)
	}
	reply := make([]byte, size)
	if _, err := io.ReadFull(conn, reply); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(reply[12:14], []byte{8, 6}) || !bytes.Equal(reply[20:22], []byte{0, 2}) || !bytes.Equal(reply[28:32], []byte{192, 168, 127, 1}) {
		t.Fatalf("not a gateway ARP reply: %x", reply)
	}
	duplicate, err := websocket.DialConfig(config)
	if err == nil {
		duplicate.Close()
		t.Fatal("second real network websocket was accepted")
	}
	b.mu.Lock()
	active := len(b.sessions)
	b.mu.Unlock()
	if active != 1 {
		t.Fatal("network session vanished while its websocket was active")
	}
	conn.Close()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		b.mu.Lock()
		active = len(b.sessions)
		b.mu.Unlock()
		if active == 0 {
			return
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal("real websocket closure did not release its network session")
}

func TestWorkerHandshakeInitializesOriginForNetworkAddresses(t *testing.T) {
	r := request("/net", true)
	config := &websocket.Config{Version: websocket.ProtocolVersionHybi13}
	if err := workerHandshake(config, r); err != nil {
		t.Fatal(err)
	}
	if config.Origin == nil || config.Origin.String() != "http://example.test" {
		t.Fatal("origin was not initialized")
	}
	r.Header.Del("Origin")
	if err := workerHandshake(&websocket.Config{Version: websocket.ProtocolVersionHybi13}, r); err == nil {
		t.Fatal("missing origin accepted")
	}
}

func request(path string, network bool) *http.Request {
	r := httptest.NewRequest("GET", "http://example.test"+path, nil)
	if network {
		r.Header.Set("Upgrade", "websocket")
		r.Header.Set("Connection", "Upgrade")
		r.Header.Set("Origin", "http://example.test")
	}
	return r
}

func response(b http.Handler, path string) *httptest.ResponseRecorder {
	w := httptest.NewRecorder()
	b.ServeHTTP(w, request(path, false))
	return w
}

func TestUnknownSessionDoesNotAllocate(t *testing.T) {
	b := newBridge(2, time.Hour, func() (*backend, error) { t.Fatal("unknown lookup allocated a worker"); return nil, nil })
	for _, path := range []string{
		"/", "/sessions/short/health", "/sessions/" + tokenA + "/health",
		"/sessions/" + tokenA + "/editor/", "/sessions/" + tokenA + "/other",
	} {
		if got := response(b, path).Code; got != http.StatusNotFound {
			t.Errorf("%s: got %d, want 404", path, got)
		}
	}
	if got := response(b, "/sessions/"+tokenA+"/net").Code; got != http.StatusBadRequest {
		t.Errorf("ordinary net request: got %d", got)
	}
}

func TestTwoSessionsStaySeparateAndConcurrentNetworkIsRejected(t *testing.T) {
	started := make(chan int, 2)
	var creations, cleanups atomic.Int32
	var mu sync.Mutex
	ends := map[int]func(){}
	b := newBridge(2, time.Hour, func() (*backend, error) {
		id := int(creations.Add(1))
		end := make(chan struct{})
		var transportOnce, closeOnce sync.Once
		stop := func() { transportOnce.Do(func() { close(end) }) }
		mu.Lock()
		ends[id] = stop
		mu.Unlock()
		return &backend{
			proxy: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path == "/net" {
					started <- id
					<-end
					return
				}
				fmt.Fprintf(w, "%d %s", id, r.URL.Path)
			}),
			close: func() { closeOnce.Do(func() { cleanups.Add(1); stop() }) },
		}, nil
	})
	defer b.close()
	doneA, doneB := make(chan struct{}), make(chan struct{})
	go func() { b.ServeHTTP(httptest.NewRecorder(), request("/sessions/"+tokenA+"/net", true)); close(doneA) }()
	if id := <-started; id != 1 {
		t.Fatal(id)
	}
	go func() { b.ServeHTTP(httptest.NewRecorder(), request("/sessions/"+tokenB+"/net", true)); close(doneB) }()
	if id := <-started; id != 2 {
		t.Fatal(id)
	}
	for _, check := range []struct{ token, expected string }{{tokenA, "1 /editor/file"}, {tokenB, "2 /editor/file"}} {
		if got := response(b, "/sessions/"+check.token+"/editor/file").Body.String(); got != check.expected {
			t.Errorf("wrong guest: got %q, want %q", got, check.expected)
		}
	}
	duplicate := httptest.NewRecorder()
	b.ServeHTTP(duplicate, request("/sessions/"+tokenA+"/net", true))
	if duplicate.Code != http.StatusConflict {
		t.Fatalf("duplicate net: got %d", duplicate.Code)
	}
	if creations.Load() != 2 {
		t.Fatal("duplicate allocated another network")
	}
	mu.Lock()
	ends[1]()
	mu.Unlock()
	select {
	case <-doneA:
	case <-time.After(time.Second):
		t.Fatal("network closure did not clean up")
	}
	if got := response(b, "/sessions/"+tokenA+"/health").Code; got != 404 {
		t.Errorf("closed session: got %d", got)
	}
	if got := response(b, "/sessions/"+tokenB+"/health").Body.String(); got != "2 /health" {
		t.Fatal(got)
	}
	if cleanups.Load() != 1 {
		t.Fatal("closed session worker was not destroyed")
	}
	b.close()
	select {
	case <-doneB:
	case <-time.After(time.Second):
		t.Fatal("shutdown did not close remaining network")
	}
	if cleanups.Load() != 2 {
		t.Fatal("shutdown leaked a worker")
	}
}

func TestLimitsExpiryAndOrigin(t *testing.T) {
	var closes atomic.Int32
	b := newBridge(1, 20*time.Millisecond, func() (*backend, error) {
		return &backend{proxy: http.NotFoundHandler(), close: func() { closes.Add(1) }}, nil
	})
	defer b.close()
	s, status := b.allocate(tokenA)
	if status != 0 || s == nil {
		t.Fatal(status)
	}
	if _, status = b.allocate(tokenB); status != 503 {
		t.Fatalf("limit: got %d", status)
	}
	deadline := time.Now().Add(time.Second)
	for closes.Load() == 0 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	if closes.Load() != 1 {
		t.Fatal("expired session worker leaked")
	}
	if _, status = b.allocate(tokenB); status != 0 {
		t.Fatalf("expired capacity not released: %d", status)
	}
	w := httptest.NewRecorder()
	r := request("/sessions/"+tokenA+"/net", true)
	r.Header.Set("Origin", "https://unrelated.test")
	b.ServeHTTP(w, r)
	if w.Code != http.StatusForbidden {
		t.Fatalf("cross-origin allocation: %d", w.Code)
	}
}

type dialNetwork struct {
	address string
	dials   []string
}

func (n *dialNetwork) AcceptQemu(context.Context, net.Conn) error { return nil }
func (n *dialNetwork) DialContextTCP(ctx context.Context, address string) (net.Conn, error) {
	n.dials = append(n.dials, address)
	return (&net.Dialer{}).DialContext(ctx, "tcp", n.address)
}

func TestGuestProxyPathQueryAndPrivateWorkerAuthentication(t *testing.T) {
	guest := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-Web-IDE-Worker-Key") != "" {
			t.Error("worker key leaked into the guest")
		}
		if r.URL.Path == "/redirect" {
			w.Header().Set("Location", "/next")
			w.WriteHeader(302)
			return
		}
		fmt.Fprintf(w, "%s %s", r.URL.Path, r.URL.RawQuery)
	}))
	defer guest.Close()
	network := &dialNetwork{address: strings.TrimPrefix(guest.URL, "http://")}
	handler := authenticatedWorker("parent-only-key", workerHandler(network, time.Minute, make(chan struct{}, 1), make(chan struct{}, 1)))
	if got := response(handler, "/editor/").Code; got != http.StatusForbidden {
		t.Fatalf("unauthenticated worker: %d", got)
	}
	for _, check := range []struct{ path, expected string }{{"/health?untrusted=query", "/ "}, {"/editor/folder/file?x=y", "/folder/file x=y"}} {
		r := request(check.path, false)
		r.Header.Set("X-Web-IDE-Worker-Key", "parent-only-key")
		r.Header.Set("X-Web-IDE-Editor-Prefix", "/sessions/"+tokenA+"/editor")
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		if got := w.Body.String(); got != check.expected {
			t.Errorf("path/query: got %q, want %q", got, check.expected)
		}
	}
	r := request("/editor/redirect", false)
	r.Header.Set("X-Web-IDE-Worker-Key", "parent-only-key")
	r.Header.Set("X-Web-IDE-Editor-Prefix", "/sessions/"+tokenA+"/editor")
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, r)
	if got := w.Header().Get("Location"); got != "/sessions/"+tokenA+"/editor/next" {
		t.Fatal(got)
	}
	for _, address := range network.dials {
		if address != guestAddress {
			t.Fatal("proxy dial escaped guest target", address)
		}
	}
}
