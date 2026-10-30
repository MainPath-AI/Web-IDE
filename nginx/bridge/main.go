// Web-IDE's session-scoped QEMU transport, based on container2wasm's
// Apache-2.0 c2w-net configuration. Each browser owns a separate network.
package main

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"os/exec"
	"os/signal"
	"strings"
	"sync"
	"syscall"
	"time"

	gvntypes "github.com/containers/gvisor-tap-vsock/pkg/types"
	gvnvirtualnetwork "github.com/containers/gvisor-tap-vsock/pkg/virtualnetwork"
	"golang.org/x/net/websocket"
)

const guestAddress = "192.168.127.3:8080"

type backend struct {
	proxy http.Handler
	close func()
}

type session struct {
	backend *backend
	timer   *time.Timer
}

type bridge struct {
	mu       sync.Mutex
	sessions map[string]*session
	limit    int
	stopped  bool
	lifetime time.Duration
	start    func() (*backend, error)
}

func newBridge(limit int, lifetime time.Duration, start func() (*backend, error)) *bridge {
	return &bridge{sessions: make(map[string]*session), limit: limit, lifetime: lifetime, start: start}
}

func validToken(token string) bool {
	if len(token) != 32 {
		return false
	}
	for _, c := range token {
		if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f') {
			return false
		}
	}
	return true
}

func sessionRoute(path string) (token, route string, ok bool) {
	if !strings.HasPrefix(path, "/sessions/") {
		return "", "", false
	}
	parts := strings.SplitN(strings.TrimPrefix(path, "/sessions/"), "/", 2)
	if len(parts) != 2 || !validToken(parts[0]) {
		return "", "", false
	}
	return parts[0], "/" + parts[1], true
}

func websocketRequest(r *http.Request) bool {
	return r.Method == http.MethodGet && strings.EqualFold(r.Header.Get("Upgrade"), "websocket") &&
		strings.Contains(","+strings.ToLower(strings.ReplaceAll(r.Header.Get("Connection"), " ", ""))+",", ",upgrade,")
}

func sameOrigin(r *http.Request) bool {
	origin, err := url.Parse(r.Header.Get("Origin"))
	return err == nil && (origin.Scheme == "http" || origin.Scheme == "https") && strings.EqualFold(origin.Host, r.Host)
}

func (b *bridge) allocate(token string) (*session, int) {
	b.mu.Lock()
	defer b.mu.Unlock()
	if b.stopped {
		return nil, http.StatusServiceUnavailable
	}
	if b.sessions[token] != nil {
		return nil, http.StatusConflict
	}
	if len(b.sessions) >= b.limit {
		return nil, http.StatusServiceUnavailable
	}
	worker, err := b.start()
	if err != nil {
		log.Print("could not start a guest network worker")
		return nil, http.StatusServiceUnavailable
	}
	s := &session{backend: worker}
	b.sessions[token] = s
	s.timer = time.AfterFunc(b.lifetime, func() { b.release(token, s) })
	return s, 0
}

func (b *bridge) release(token string, s *session) {
	b.mu.Lock()
	if b.sessions[token] != s {
		b.mu.Unlock()
		return
	}
	delete(b.sessions, token)
	s.timer.Stop()
	b.mu.Unlock()
	s.backend.close()
}

func (b *bridge) close() {
	b.mu.Lock()
	b.stopped = true
	current := make(map[string]*session, len(b.sessions))
	for token, s := range b.sessions {
		current[token] = s
	}
	b.mu.Unlock()
	for token, s := range current {
		b.release(token, s)
	}
}

func (b *bridge) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Referrer-Policy", "no-referrer")
	token, route, ok := sessionRoute(r.URL.Path)
	if !ok {
		http.NotFound(w, r)
		return
	}
	var s *session
	if route == "/net" {
		if !websocketRequest(r) {
			http.Error(w, "websocket required", http.StatusBadRequest)
			return
		}
		if !sameOrigin(r) {
			http.Error(w, "origin rejected", http.StatusForbidden)
			return
		}
		var status int
		s, status = b.allocate(token)
		if status != 0 {
			http.Error(w, http.StatusText(status), status)
			return
		}
		// The net websocket is the lease. Its closure destroys the worker,
		// including gVisor's otherwise uncloseable DNS/DHCP goroutines.
		defer b.release(token, s)
	} else {
		if route != "/health" && !strings.HasPrefix(route, "/editor/") {
			http.NotFound(w, r)
			return
		}
		b.mu.Lock()
		s = b.sessions[token]
		b.mu.Unlock()
		if s == nil {
			http.NotFound(w, r)
			return
		}
	}
	request := r.Clone(r.Context())
	request.URL.Path = route
	request.URL.RawPath = ""
	request.Header.Set("X-Web-IDE-Editor-Prefix", "/sessions/"+token+"/editor")
	s.backend.proxy.ServeHTTP(w, request)
}

// A separate process is required because this gvisor-tap-vsock release has
// no VirtualNetwork.Close. A goroutine-only implementation leaks its stack.
// The listener is inherited while still open; no ephemeral-port race exists.
func startWorker(executable string, idle time.Duration) (*backend, error) {
	listener, err := net.ListenTCP("tcp", &net.TCPAddr{IP: net.IPv4(127, 0, 0, 1)})
	if err != nil {
		return nil, err
	}
	defer listener.Close()
	file, err := listener.File()
	if err != nil {
		return nil, err
	}
	defer file.Close()
	cmd := exec.Command(executable, "-worker-fd=3", "-idle-timeout="+idle.String())
	secretBytes := make([]byte, 32)
	if _, err := rand.Read(secretBytes); err != nil {
		return nil, err
	}
	secret := hex.EncodeToString(secretBytes)
	cmd.Env = append(os.Environ(), "WEB_IDE_WORKER_KEY="+secret)
	cmd.ExtraFiles = []*os.File{file}
	cmd.Stderr = os.Stderr
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	done := make(chan struct{})
	go func() { _ = cmd.Wait(); close(done) }()
	target := &url.URL{Scheme: "http", Host: listener.Addr().String()}
	transport := &http.Transport{Proxy: nil, DialContext: (&net.Dialer{Timeout: 10 * time.Second}).DialContext, ResponseHeaderTimeout: 45 * time.Second}
	proxy := httputil.NewSingleHostReverseProxy(target)
	director := proxy.Director
	proxy.Director = func(r *http.Request) {
		director(r)
		r.Header.Set("X-Web-IDE-Worker-Key", secret)
	}
	proxy.Transport = transport
	proxy.ErrorLog = log.New(io.Discard, "", 0)
	proxy.ErrorHandler = func(w http.ResponseWriter, _ *http.Request, _ error) {
		http.Error(w, "guest unavailable", http.StatusServiceUnavailable)
	}
	var once sync.Once
	return &backend{proxy: proxy, close: func() {
		once.Do(func() {
			transport.CloseIdleConnections()
			_ = cmd.Process.Kill()
			<-done
		})
	}}, nil
}

type guestNetwork interface {
	AcceptQemu(context.Context, net.Conn) error
	DialContextTCP(context.Context, string) (net.Conn, error)
}

type idleConn struct {
	net.Conn
	idle time.Duration
}

func (c *idleConn) Read(p []byte) (int, error) {
	_ = c.Conn.SetReadDeadline(time.Now().Add(c.idle))
	return c.Conn.Read(p)
}

func guestProxy(network guestNetwork) *httputil.ReverseProxy {
	proxy := httputil.NewSingleHostReverseProxy(&url.URL{Scheme: "http", Host: guestAddress})
	proxy.Transport = &http.Transport{
		Proxy: nil,
		DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
			timeout, cancel := context.WithTimeout(ctx, 15*time.Second)
			defer cancel()
			return network.DialContextTCP(timeout, guestAddress)
		},
		ResponseHeaderTimeout: 40 * time.Second,
	}
	proxy.ErrorLog = log.New(io.Discard, "", 0)
	proxy.ErrorHandler = func(w http.ResponseWriter, _ *http.Request, _ error) {
		http.Error(w, "guest unavailable", http.StatusServiceUnavailable)
	}
	proxy.ModifyResponse = func(response *http.Response) error {
		prefix := response.Request.Header.Get("X-Web-IDE-Editor-Prefix")
		if location := response.Header.Get("Location"); strings.HasPrefix(location, "/") && !strings.HasPrefix(location, "//") {
			response.Header.Set("Location", prefix+location)
		}
		return nil
	}
	return proxy
}

func workerHandshake(config *websocket.Config, request *http.Request) error {
	// Match websocket.Handler's upstream initialization. AcceptQemu calls
	// RemoteAddr().String(), whose URL comes from config.Origin even when
	// debug logging is disabled. A nil Origin panics after HTTP 101.
	origin, err := websocket.Origin(config, request)
	if err != nil || origin == nil {
		return errors.New("invalid network websocket origin")
	}
	config.Origin = origin
	return nil
}

func workerHandler(network guestNetwork, idle time.Duration, connected, done chan<- struct{}) http.Handler {
	proxy := guestProxy(network)
	mux := http.NewServeMux()
	mux.Handle("/net", websocket.Server{
		// Only the parent can reach this loopback worker and it already
		// checked the browser Origin against the public request Host.
		Handshake: workerHandshake,
		Handler: func(ws *websocket.Conn) {
			defer ws.Close()
			select {
			case connected <- struct{}{}:
			default:
			}
			defer func() {
				select {
				case done <- struct{}{}:
				default:
				}
			}()
			defer func() {
				if reason := recover(); reason != nil {
					// Do not log request URLs, bearer tokens, or packet contents.
					// Log before notifying the process owner that its lease ended.
					log.Printf("guest network transport panicked (%T)", reason)
				}
			}()
			ws.PayloadType = websocket.BinaryFrame
			ws.MaxPayloadBytes = 16 << 20
			if err := network.AcceptQemu(context.Background(), &idleConn{Conn: ws, idle: idle}); err != nil && !errors.Is(err, io.EOF) {
				log.Printf("guest network transport ended unexpectedly (%T)", err)
			}
		},
	})
	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet && r.Method != http.MethodHead {
			http.Error(w, "GET required", http.StatusMethodNotAllowed)
			return
		}
		request := r.Clone(r.Context())
		request.URL.Path, request.URL.RawPath, request.URL.RawQuery = "/", "", ""
		proxy.ServeHTTP(w, request)
	})
	mux.Handle("/editor/", http.StripPrefix("/editor", proxy))
	return mux
}

// Guest NAT can reach loopback, including other workers' ephemeral ports.
// Those private listeners therefore require an independent parent-only key.
func authenticatedWorker(key string, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if key == "" || subtle.ConstantTimeCompare([]byte(r.Header.Get("X-Web-IDE-Worker-Key")), []byte(key)) != 1 {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		r.Header.Del("X-Web-IDE-Worker-Key")
		next.ServeHTTP(w, r)
	})
}

func serveWorker(fd int, idle time.Duration) error {
	file := os.NewFile(uintptr(fd), "guest-network-listener")
	if file == nil {
		return errors.New("missing worker listener")
	}
	listener, err := net.FileListener(file)
	file.Close()
	if err != nil {
		return err
	}
	defer listener.Close()
	network, err := gvnvirtualnetwork.New(&gvntypes.Configuration{
		MTU: 1500, Subnet: "192.168.127.0/24",
		GatewayIP: "192.168.127.1", GatewayMacAddress: "5a:94:ef:e4:0c:dd",
		DHCPStaticLeases:  map[string]string{"192.168.127.3": "02:00:00:00:00:01"},
		NAT:               map[string]string{"192.168.127.254": "127.0.0.1"},
		GatewayVirtualIPs: []string{"192.168.127.254"}, Protocol: gvntypes.QemuProtocol,
	})
	if err != nil {
		return err
	}
	key := os.Getenv("WEB_IDE_WORKER_KEY")
	os.Unsetenv("WEB_IDE_WORKER_KEY")
	if key == "" {
		return fmt.Errorf("missing worker authentication")
	}
	connected, done := make(chan struct{}, 1), make(chan struct{}, 1)
	server := &http.Server{Handler: authenticatedWorker(key, workerHandler(network, idle, connected, done)), ReadHeaderTimeout: 10 * time.Second, IdleTimeout: 60 * time.Second}
	defer server.Close()
	errors := make(chan error, 1)
	go func() { errors <- server.Serve(listener) }()
	select {
	case <-connected:
		select {
		case <-done:
			return nil
		case err := <-errors:
			return err
		}
	case <-done:
		return nil
	case err := <-errors:
		return err
	case <-time.After(30 * time.Second):
		// A worker without its owning net websocket is never retained.
		return fmt.Errorf("network websocket did not connect")
	}
}

func main() {
	listen := flag.String("listen", "127.0.0.1:8888", "parent HTTP listen address")
	workerFD := flag.Int("worker-fd", 0, "internal inherited worker listener")
	limit := flag.Int("max-sessions", 16, "maximum simultaneous browser guests")
	idle := flag.Duration("idle-timeout", 30*time.Minute, "maximum interval between guest network packets")
	lifetime := flag.Duration("session-lifetime", 4*time.Hour, "maximum guest network lifetime")
	flag.Parse()
	if *workerFD != 0 {
		if err := serveWorker(*workerFD, *idle); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatal(err)
		}
		return
	}
	if *limit < 1 || *idle <= 0 || *lifetime <= 0 {
		log.Fatal("session limits and timeouts must be positive")
	}
	executable, err := os.Executable()
	if err != nil {
		log.Fatal(err)
	}
	b := newBridge(*limit, *lifetime, func() (*backend, error) { return startWorker(executable, *idle) })
	defer b.close()
	server := &http.Server{Addr: *listen, Handler: b, ReadHeaderTimeout: 10 * time.Second, IdleTimeout: 60 * time.Second, MaxHeaderBytes: 64 << 10}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go func() { <-ctx.Done(); b.close(); _ = server.Close() }()
	if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		log.Fatal(err)
	}
}
