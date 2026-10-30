package main

import (
	"archive/tar"
	"bytes"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func fixture(t *testing.T) *workspace {
	t.Helper()
	w := &workspace{root: filepath.Join(t.TempDir(), "project")}
	if err := os.Mkdir(w.root, 0755); err != nil {
		t.Fatal(err)
	}
	w.revision.Store(1)
	return w
}

func TestArchiveRestoresFilesModesLinksAndDeletions(t *testing.T) {
	w := fixture(t)
	if err := os.Mkdir(filepath.Join(w.root, "src"), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(w.root, "src/run.sh"), []byte("#!/bin/sh\necho saved\n"), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink("src/run.sh", filepath.Join(w.root, "run")); err != nil {
		t.Fatal(err)
	}
	data, _, err := w.archive()
	if err != nil {
		t.Fatal(err)
	}
	destination := fixture(t)
	if err := os.WriteFile(filepath.Join(destination.root, "deleted"), []byte("old"), 0644); err != nil {
		t.Fatal(err)
	}
	before, _ := os.Stat(destination.root)
	if err := destination.restore(bytes.NewReader(data)); err != nil {
		t.Fatal(err)
	}
	after, _ := os.Stat(destination.root)
	if !os.SameFile(before, after) {
		t.Fatal("workspace root inode changed")
	}
	content, err := os.ReadFile(filepath.Join(destination.root, "run"))
	if err != nil || string(content) != "#!/bin/sh\necho saved\n" {
		t.Fatalf("restored file: %q %v", content, err)
	}
	info, _ := os.Stat(filepath.Join(destination.root, "src/run.sh"))
	if info.Mode().Perm() != 0755 {
		t.Fatal("executable mode lost")
	}
	if _, err := os.Stat(filepath.Join(destination.root, "deleted")); !os.IsNotExist(err) {
		t.Fatal("deleted file was restored")
	}
}

func maliciousArchive(t *testing.T, header *tar.Header) []byte {
	t.Helper()
	var data bytes.Buffer
	tw := tar.NewWriter(&data)
	if err := tw.WriteHeader(header); err != nil {
		t.Fatal(err)
	}
	if err := tw.Close(); err != nil {
		t.Fatal(err)
	}
	return data.Bytes()
}

func TestInvalidRestorePreservesExistingWorkspace(t *testing.T) {
	for _, header := range []*tar.Header{
		{Name: "../escape", Typeflag: tar.TypeReg, Mode: 0644},
		{Name: "/absolute", Typeflag: tar.TypeReg, Mode: 0644},
		{Name: "symlink", Typeflag: tar.TypeSymlink, Linkname: "../../escape"},
		{Name: "hardlink", Typeflag: tar.TypeLink, Linkname: "file"},
		{Name: "device", Typeflag: tar.TypeChar},
	} {
		t.Run(header.Name, func(t *testing.T) {
			w := fixture(t)
			file := filepath.Join(w.root, "keep")
			if err := os.WriteFile(file, []byte("keep"), 0644); err != nil {
				t.Fatal(err)
			}
			if err := w.restore(bytes.NewReader(maliciousArchive(t, header))); err == nil {
				t.Fatal("unsafe archive accepted")
			}
			if data, err := os.ReadFile(file); err != nil || string(data) != "keep" {
				t.Fatal("workspace lost after rejected restore")
			}
		})
	}
	if err := fixture(t).restore(bytes.NewReader(nil)); err == nil {
		t.Fatal("empty/truncated transfer accepted")
	}
}

func TestWorkspaceRequiresHeaderAndCannotRestoreAfterReady(t *testing.T) {
	w := fixture(t)
	request := func(method, path string, header bool) int {
		r := httptest.NewRequest(method, path, nil)
		if header {
			r.Header.Set("X-Web-IDE-Workspace", "1")
		}
		response := httptest.NewRecorder()
		w.ServeHTTP(response, r)
		return response.Code
	}
	if request(http.MethodGet, "/status", false) != 403 {
		t.Fatal("cross-site request accepted")
	}
	if request(http.MethodGet, "/status", true) != 200 {
		t.Fatal("status failed")
	}
	if request(http.MethodPost, "/ready", true) != 204 {
		t.Fatal("ready failed")
	}
	if request(http.MethodPost, "/restore", true) != 409 {
		t.Fatal("running workspace can be overwritten")
	}
}
