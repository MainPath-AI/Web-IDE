// Workspace backups travel between this browser guest and its owning browser.
// Nothing is stored on the deployment host.
package main

import (
	"archive/tar"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

const maxArchive = 100 << 20
const maxEntries = 20000

type workspace struct {
	root        string
	mu          sync.Mutex
	revision    atomic.Uint64
	restored    bool
	watchFailed atomic.Bool
}

func localName(name string) bool {
	return filepath.IsLocal(name) && name != "." && !strings.Contains(name, "\\") && filepath.Clean(name) == name
}

func (w *workspace) archive() ([]byte, uint64, error) {
	root, err := os.OpenRoot(w.root)
	if err != nil {
		return nil, 0, err
	}
	defer root.Close()
	var b bytes.Buffer
	tw := tar.NewWriter(&b)
	revision := w.revision.Load()
	count := 0
	err = filepath.WalkDir(w.root, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if path == w.root {
			return nil
		}
		count++
		if count > maxEntries {
			return errors.New("workspace has too many files")
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		name, err := filepath.Rel(w.root, path)
		if err != nil || !localName(name) {
			return errors.New("invalid workspace path")
		}
		link := ""
		if info.Mode()&os.ModeSymlink != 0 {
			link, err = os.Readlink(path)
			if err != nil {
				return err
			}
			if !filepath.IsLocal(filepath.Join(filepath.Dir(name), link)) || filepath.IsAbs(link) {
				return errors.New("workspace contains an external symbolic link")
			}
		} else if !info.IsDir() && !info.Mode().IsRegular() {
			return errors.New("workspace contains a special file")
		}
		if info.Size() > maxArchive || b.Len()+int(info.Size())+1024 > maxArchive {
			return errors.New("workspace exceeds 100 MiB")
		}
		header, err := tar.FileInfoHeader(info, link)
		if err != nil {
			return err
		}
		header.Name = filepath.ToSlash(name)
		if err := tw.WriteHeader(header); err != nil {
			return err
		}
		if info.Mode().IsRegular() {
			file, err := root.Open(name)
			if err != nil {
				return err
			}
			_, copyErr := io.CopyN(tw, file, info.Size())
			after, statErr := file.Stat()
			file.Close()
			if copyErr != nil {
				return copyErr
			}
			if statErr != nil || !os.SameFile(after, info) || after.Size() != info.Size() || !after.ModTime().Equal(info.ModTime()) {
				return errors.New("workspace changed during backup; retry")
			}
		}
		return nil
	})
	if err != nil {
		return nil, 0, err
	}
	if err := tw.Close(); err != nil {
		return nil, 0, err
	}
	if b.Len() > maxArchive {
		return nil, 0, errors.New("workspace exceeds 100 MiB")
	}
	return b.Bytes(), revision, nil
}

func unpack(reader io.Reader, stage string) error {
	data, err := io.ReadAll(io.LimitReader(reader, maxArchive+1))
	if err != nil {
		return err
	}
	if len(data) < 1024 || len(data) > maxArchive || len(data)%512 != 0 || !bytes.Equal(data[len(data)-1024:], make([]byte, 1024)) {
		return errors.New("incomplete workspace archive")
	}
	root, err := os.OpenRoot(stage)
	if err != nil {
		return err
	}
	defer root.Close()
	tr := tar.NewReader(bytes.NewReader(data))
	seen := make(map[string]bool)
	var total int64
	for {
		header, err := tr.Next()
		if err == io.EOF {
			return nil
		}
		if err != nil {
			return err
		}
		name := strings.TrimSuffix(header.Name, "/")
		if !localName(name) || seen[name] || len(seen) >= maxEntries {
			return errors.New("invalid or duplicate archive path")
		}
		seen[name] = true
		total += header.Size
		if header.Size < 0 || total > maxArchive {
			return errors.New("workspace exceeds 100 MiB")
		}
		if err := root.MkdirAll(filepath.Dir(name), 0755); err != nil {
			return err
		}
		switch header.Typeflag {
		case tar.TypeDir:
			if err := root.MkdirAll(name, 0755); err != nil {
				return err
			}
		case tar.TypeReg:
			file, err := root.OpenFile(name, os.O_CREATE|os.O_EXCL|os.O_WRONLY, os.FileMode(header.Mode)&0777)
			if err != nil {
				return err
			}
			_, err = io.CopyN(file, tr, header.Size)
			closeErr := file.Close()
			if err != nil {
				return err
			}
			if closeErr != nil {
				return closeErr
			}
		case tar.TypeSymlink:
			if filepath.IsAbs(header.Linkname) || !filepath.IsLocal(filepath.Join(filepath.Dir(name), header.Linkname)) {
				return errors.New("external symbolic link")
			}
			if err := root.Symlink(header.Linkname, name); err != nil {
				return err
			}
		default:
			return errors.New("unsupported archive entry")
		}
	}
}

func (w *workspace) restore(reader io.Reader) error {
	stage, err := os.MkdirTemp(filepath.Dir(w.root), ".workspace-restore-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(stage)
	if err := unpack(reader, stage); err != nil {
		return err
	}
	// Preserve the root inode: code-server's working directory is already here.
	old, err := os.MkdirTemp(filepath.Dir(w.root), ".workspace-previous-")
	if err != nil {
		return err
	}
	defer os.RemoveAll(old)
	move := func(from, to string) error {
		entries, err := os.ReadDir(from)
		if err != nil {
			return err
		}
		for _, entry := range entries {
			if err := os.Rename(filepath.Join(from, entry.Name()), filepath.Join(to, entry.Name())); err != nil {
				return err
			}
		}
		return nil
	}
	if err := move(w.root, old); err != nil {
		_ = move(old, w.root)
		return err
	}
	if err := move(stage, w.root); err != nil {
		_ = move(w.root, stage)
		_ = move(old, w.root)
		return err
	}
	w.revision.Add(1)
	return nil
}

func (w *workspace) ServeHTTP(response http.ResponseWriter, request *http.Request) {
	response.Header().Set("Cache-Control", "no-store")
	response.Header().Set("X-Content-Type-Options", "nosniff")
	// The service only accepts browser requests relayed by the session bridge.
	// Cross-site forms cannot supply this non-simple header.
	if request.Header.Get("X-Web-IDE-Workspace") != "1" {
		http.Error(response, "workspace header required", http.StatusForbidden)
		return
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	switch {
	case request.Method == http.MethodGet && request.URL.Path == "/status":
		if w.watchFailed.Load() {
			http.Error(response, "Workspace watching failed; download a backup", http.StatusServiceUnavailable)
			return
		}
		response.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(response).Encode(map[string]any{"revision": w.revision.Load(), "ready": true})
	case request.Method == http.MethodGet && request.URL.Path == "/archive":
		data, revision, err := w.archive()
		if err != nil {
			http.Error(response, "Could not back up workspace: "+err.Error(), http.StatusConflict)
			return
		}
		response.Header().Set("Content-Type", "application/x-tar")
		response.Header().Set("X-Workspace-Revision", strconv.FormatUint(revision, 10))
		_, _ = response.Write(data)
	case request.Method == http.MethodPost && request.URL.Path == "/restore":
		if w.restored {
			http.Error(response, "workspace already initialized", http.StatusConflict)
			return
		}
		if err := w.restore(http.MaxBytesReader(response, request.Body, maxArchive)); err != nil {
			http.Error(response, "Invalid workspace backup", http.StatusBadRequest)
			return
		}
		w.restored = true
		response.WriteHeader(http.StatusNoContent)
	case request.Method == http.MethodPost && request.URL.Path == "/ready":
		w.restored = true
		response.WriteHeader(http.StatusNoContent)
	default:
		http.NotFound(response, request)
	}
}

func main() {
	w := &workspace{root: "/opt/web-ide/demos"}
	w.revision.Store(1)
	if err := watchWorkspace(w); err != nil {
		log.Fatal("workspace watcher unavailable")
	}
	server := &http.Server{Addr: ":9090", Handler: w, ReadHeaderTimeout: 10 * time.Second, ReadTimeout: 2 * time.Minute, IdleTimeout: time.Minute}
	fmt.Println("WEB_IDE_WORKSPACE_READY")
	log.Fatal(server.ListenAndServe())
}
