// Web-IDE's snapshot helper for container2wasm v0.8.4 (Apache-2.0).
// Capture the guest after its editor starts, and wait for QEMU to finish
// migration before publishing the state file. File existence alone is unsafe.
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"os"
	"os/exec"
	"path/filepath"
	"time"
)

const snapshotMarker = "WEB_IDE_SNAPSHOT"

func main() {
	output := flag.String("output", "vm.state", "path to the completed state file")
	argsPath := flag.String("args-json", "", "path to QEMU arguments")
	warmCommand := flag.String("warm-command", "", "JSON command arguments to warm guest services before capture")
	flag.Parse()
	if err := runWithWarmup(*output, *argsPath, flag.Args(), *warmCommand); err != nil {
		log.Fatal(err)
	}
}

func run(output, argsPath string, command []string) error {
	return runWithWarmup(output, argsPath, command, "")
}

func runWithWarmup(output, argsPath string, command []string, warmCommand string) error {
	if output == "" || argsPath == "" || len(command) != 1 {
		return errors.New("specify -output, -args-json, and the QEMU executable")
	}
	data, err := os.ReadFile(argsPath)
	if err != nil {
		return err
	}
	var args []string
	if err := json.Unmarshal(data, &args); err != nil {
		return err
	}
	dir, err := os.MkdirTemp("", "web-ide-qmp-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(dir)
	socket := filepath.Join(dir, "qmp.sock")
	// Preserve the template's serial/monitor topology, which the browser uses
	// too. A separate QMP socket supplies control without changing that device.
	args = append(args, "-qmp", "unix:"+socket+",server=on,wait=off")
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Minute)
	defer cancel()
	cmd := exec.CommandContext(ctx, command[0], args...)
	// Keep the serial input open, as it is in the browser's PTY. An absent
	// stdin connects QEMU to /dev/null and can close its character backend.
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return err
	}
	defer stdin.Close()
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return err
	}
	cmd.Stderr = os.Stderr
	if err := cmd.Start(); err != nil {
		return err
	}
	waited := false
	defer func() {
		if !waited {
			_ = cmd.Process.Kill()
			_ = cmd.Wait()
		}
	}()
	ready := make(chan error, 1)
	go func() {
		ready <- waitForMarker(stdout, os.Stdout, snapshotMarker)
		_, _ = io.Copy(os.Stdout, stdout)
	}()
	select {
	case err := <-ready:
		if err != nil {
			return fmt.Errorf("waiting for guest editor: %w", err)
		}
	case <-ctx.Done():
		return fmt.Errorf("waiting for %s: %w", snapshotMarker, ctx.Err())
	}
	if warmCommand != "" {
		var warmArgs []string
		if err := json.Unmarshal([]byte(warmCommand), &warmArgs); err != nil || len(warmArgs) == 0 {
			return errors.New("warm-command must be a nonempty JSON command array")
		}
		log.Println("guest editor HTTP ready; warming the actual remote and terminal services")
		warm := exec.CommandContext(ctx, warmArgs[0], warmArgs[1:]...)
		warm.Stdout = os.Stdout
		warm.Stderr = os.Stderr
		if err := warm.Run(); err != nil {
			return fmt.Errorf("guest service warmup failed: %w", err)
		}
	}
	log.Println("guest editor ready; capturing a complete snapshot")
	qmp, err := connectQMP(ctx, socket)
	if err != nil {
		return err
	}
	defer qmp.conn.Close()
	status, err := qmp.execute("query-status", nil)
	if err != nil {
		return err
	}
	var stateBeforeMigration struct {
		Running bool `json:"running"`
	}
	if err := json.Unmarshal(status, &stateBeforeMigration); err != nil || !stateBeforeMigration.Running {
		return errors.New("guest must be running before migration so the browser resumes it")
	}
	// Migration suspends the CPUs atomically. An explicit stop here would save
	// runstate=paused and leave an incoming browser VM permanently paused.
	state, err := os.CreateTemp(filepath.Dir(output), ".vm-state-*.partial")
	if err != nil {
		return err
	}
	partial := state.Name()
	_ = state.Close()
	defer os.Remove(partial)
	if err := captureMigration(ctx, qmp, partial); err != nil {
		return err
	}
	// QEMU may close the QMP connection before replying to quit.
	if _, err := qmp.execute("quit", nil); err != nil && !errors.Is(err, io.EOF) {
		return err
	}
	err = cmd.Wait()
	waited = true
	if err != nil {
		return fmt.Errorf("QEMU exit: %w", err)
	}
	f, err := os.Open(partial)
	if err != nil {
		return err
	}
	var magic [4]byte
	_, err = io.ReadFull(f, magic[:])
	_ = f.Close()
	if err != nil || string(magic[:]) != "QEVM" {
		return errors.New("completed migration is not a QEMU state file")
	}
	return os.Rename(partial, output)
}

func waitForMarker(src io.Reader, dst io.Writer, marker string) error {
	var window []byte
	buf := make([]byte, 4096)
	for {
		n, err := src.Read(buf)
		if n > 0 {
			if _, e := dst.Write(buf[:n]); e != nil {
				return e
			}
			window = append(window, buf[:n]...)
			if bytes.Contains(window, []byte(marker)) {
				return nil
			}
			if len(window) >= len(marker) {
				window = window[len(window)-len(marker)+1:]
			}
		}
		if err != nil {
			return fmt.Errorf("guest output ended before %s: %w", marker, err)
		}
	}
}

type qmpClient struct {
	conn    net.Conn
	decoder *json.Decoder
	encoder *json.Encoder
	id      int
}

func connectQMP(ctx context.Context, socket string) (*qmpClient, error) {
	var conn net.Conn
	var err error
	for {
		conn, err = (&net.Dialer{}).DialContext(ctx, "unix", socket)
		if err == nil {
			break
		}
		select {
		case <-ctx.Done():
			return nil, ctx.Err()
		case <-time.After(100 * time.Millisecond):
		}
	}
	q := &qmpClient{conn: conn, decoder: json.NewDecoder(conn), encoder: json.NewEncoder(conn)}
	_ = conn.SetDeadline(time.Now().Add(30 * time.Second))
	var greeting map[string]json.RawMessage
	if err := q.decoder.Decode(&greeting); err != nil {
		_ = conn.Close()
		return nil, err
	}
	if _, ok := greeting["QMP"]; !ok {
		_ = conn.Close()
		return nil, errors.New("missing QMP greeting")
	}
	if _, err := q.execute("qmp_capabilities", nil); err != nil {
		_ = conn.Close()
		return nil, err
	}
	return q, nil
}

func (q *qmpClient) execute(command string, args map[string]any) (json.RawMessage, error) {
	q.id++
	_ = q.conn.SetDeadline(time.Now().Add(30 * time.Second))
	request := map[string]any{"execute": command, "id": q.id}
	if args != nil {
		request["arguments"] = args
	}
	if err := q.encoder.Encode(request); err != nil {
		return nil, err
	}
	for {
		var response struct {
			ID     int             `json:"id"`
			Result json.RawMessage `json:"return"`
			Error  json.RawMessage `json:"error"`
		}
		if err := q.decoder.Decode(&response); err != nil {
			return nil, err
		}
		if response.ID != q.id {
			continue // asynchronous QMP events
		}
		if response.Error != nil {
			return nil, fmt.Errorf("QMP %s: %s", command, response.Error)
		}
		return response.Result, nil
	}
}

func captureMigration(ctx context.Context, q *qmpClient, output string) error {
	if _, err := q.execute("migrate", map[string]any{"uri": "file:" + output}); err != nil {
		return err
	}
	for {
		data, err := q.execute("query-migrate", nil)
		if err != nil {
			return err
		}
		var migration struct {
			Status string `json:"status"`
			Error  string `json:"error-desc"`
		}
		if err := json.Unmarshal(data, &migration); err != nil {
			return err
		}
		switch migration.Status {
		case "completed":
			return nil
		case "failed", "cancelled":
			return fmt.Errorf("QEMU migration %s: %s", migration.Status, migration.Error)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(100 * time.Millisecond):
		}
	}
}
