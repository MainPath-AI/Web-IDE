package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

type chunks struct{ parts []string }

func (c *chunks) Read(dst []byte) (int, error) {
	if len(c.parts) == 0 {
		return 0, io.EOF
	}
	n := copy(dst, c.parts[0])
	c.parts[0] = c.parts[0][n:]
	if c.parts[0] == "" {
		c.parts = c.parts[1:]
	}
	return n, nil
}

func TestMarkerAcrossSerialChunks(t *testing.T) {
	reader := &chunks{[]string{"boot\nWEB_", "IDE_", "SNAP", "SHOT\n"}}
	if err := waitForMarker(reader, io.Discard, snapshotMarker); err != nil {
		t.Fatal(err)
	}
	if err := waitForMarker(strings.NewReader("WEB_IDE_WAIT\n"), io.Discard, snapshotMarker); err == nil {
		t.Fatal("accepted guest output without the snapshot marker")
	}
}

func TestWaitsForMigrationCompletion(t *testing.T) {
	client, server := net.Pipe()
	defer client.Close()
	queries := make(chan int, 1)
	go func() {
		defer server.Close()
		decode, encode := json.NewDecoder(server), json.NewEncoder(server)
		count := 0
		for {
			var request struct {
				Command string `json:"execute"`
				ID      int    `json:"id"`
			}
			if err := decode.Decode(&request); err != nil {
				return
			}
			result := map[string]any{}
			if request.Command == "query-migrate" {
				count++
				result["status"] = "active"
				if count == 2 {
					result["status"] = "completed"
				}
			}
			// QMP events must not be confused with command replies.
			_ = encode.Encode(map[string]any{"event": "RESUME"})
			if err := encode.Encode(map[string]any{"id": request.ID, "return": result}); err != nil {
				return
			}
			if count == 2 {
				queries <- count
				return
			}
		}
	}()
	q := &qmpClient{conn: client, decoder: json.NewDecoder(client), encoder: json.NewEncoder(client)}
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	if err := captureMigration(ctx, q, "/tmp/state"); err != nil {
		t.Fatal(err)
	}
	if got := <-queries; got != 2 {
		t.Fatalf("queried migration %d times", got)
	}
}

func TestMigrationFailureIsNotPublished(t *testing.T) {
	client, server := net.Pipe()
	defer client.Close()
	go func() {
		defer server.Close()
		decode, encode := json.NewDecoder(server), json.NewEncoder(server)
		for {
			var request map[string]any
			if err := decode.Decode(&request); err != nil {
				return
			}
			result := map[string]any{}
			if request["execute"] == "query-migrate" {
				result = map[string]any{"status": "failed", "error-desc": "write failed"}
			}
			if err := encode.Encode(map[string]any{"id": request["id"], "return": result}); err != nil {
				return
			}
		}
	}()
	q := &qmpClient{conn: client, decoder: json.NewDecoder(client), encoder: json.NewEncoder(client)}
	if err := captureMigration(context.Background(), q, "/tmp/state"); err == nil || !strings.Contains(err.Error(), "write failed") {
		t.Fatalf("expected migration failure, got %v", err)
	}
}

func TestPublishesOnlyTheCompletedSnapshot(t *testing.T) {
	t.Setenv("WEB_IDE_FAKE_QEMU", "1")
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	argsPath := filepath.Join(dir, "args.json")
	if err := os.WriteFile(argsPath, []byte(`["-test.run=TestQEMUHelperProcess", "--"]`), 0600); err != nil {
		t.Fatal(err)
	}
	output := filepath.Join(dir, "vm.state")
	if err := run(output, argsPath, []string{executable}); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(output)
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != "QEVM-complete" {
		t.Fatalf("published incomplete migration: %q", data)
	}
	partials, err := filepath.Glob(filepath.Join(dir, ".vm-state-*.partial"))
	if err != nil || len(partials) != 0 {
		t.Fatalf("temporary migration files remain: %v %v", partials, err)
	}
}

func TestFailedServiceWarmupCannotPublishASnapshot(t *testing.T) {
	t.Setenv("WEB_IDE_FAKE_QEMU", "1")
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	dir := t.TempDir()
	argsPath := filepath.Join(dir, "args.json")
	if err := os.WriteFile(argsPath, []byte(`["-test.run=TestQEMUHelperProcess", "--"]`), 0600); err != nil {
		t.Fatal(err)
	}
	output := filepath.Join(dir, "vm.state")
	err = runWithWarmup(output, argsPath, []string{executable}, `["/bin/sh","-c","exit 7"]`)
	if err == nil || !strings.Contains(err.Error(), "guest service warmup failed") {
		t.Fatalf("expected failed warmup to abort, got %v", err)
	}
	if _, err := os.Stat(output); !os.IsNotExist(err) {
		t.Fatalf("failed service warmup published a snapshot: %v", err)
	}
}

// A QMP-speaking child process exercises the actual launcher and atomic publish
// path without needing Docker or an emulator for this regression test.
func TestQEMUHelperProcess(t *testing.T) {
	if os.Getenv("WEB_IDE_FAKE_QEMU") != "1" {
		return
	}
	var socket string
	for i, arg := range os.Args {
		if arg == "-qmp" {
			socket = strings.Split(strings.TrimPrefix(os.Args[i+1], "unix:"), ",")[0]
		}
	}
	listener, err := net.Listen("unix", socket)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}
	defer listener.Close()
	fmt.Print("boot\nWEB_IDE_SNAPSHOT\n")
	conn, err := listener.Accept()
	if err != nil {
		os.Exit(3)
	}
	defer conn.Close()
	decode, encode := json.NewDecoder(conn), json.NewEncoder(conn)
	_ = encode.Encode(map[string]any{"QMP": map[string]any{}})
	var partial string
	queries := 0
	for {
		var request struct {
			Command string            `json:"execute"`
			ID      int               `json:"id"`
			Args    map[string]string `json:"arguments"`
		}
		if decode.Decode(&request) != nil {
			os.Exit(4)
		}
		result := map[string]any{}
		switch request.Command {
		case "query-status":
			result["running"] = true
			result["status"] = "running"
		case "stop":
			// Saving a paused runstate would prevent the browser from resuming.
			os.Exit(8)
		case "migrate":
			partial = strings.TrimPrefix(request.Args["uri"], "file:")
			if os.WriteFile(partial, []byte("QEVM-partial"), 0600) != nil {
				os.Exit(5)
			}
		case "query-migrate":
			queries++
			result["status"] = "active"
			if queries == 2 {
				if os.WriteFile(partial, []byte("QEVM-complete"), 0600) != nil {
					os.Exit(6)
				}
				result["status"] = "completed"
			}
		}
		if encode.Encode(map[string]any{"id": request.ID, "return": result}) != nil {
			os.Exit(7)
		}
		if request.Command == "quit" {
			os.Exit(0)
		}
	}
}
