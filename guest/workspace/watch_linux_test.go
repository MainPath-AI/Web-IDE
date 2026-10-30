package main

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestWatcherDetectsNewDirectoriesAndAtomicSaves(t *testing.T) {
	w := fixture(t)
	if err := watchWorkspace(w); err != nil {
		t.Fatal(err)
	}
	waitChange := func(before uint64) {
		t.Helper()
		deadline := time.Now().Add(5 * time.Second)
		for time.Now().Before(deadline) {
			if w.revision.Load() > before {
				return
			}
			time.Sleep(10 * time.Millisecond)
		}
		t.Fatal("workspace edit did not invalidate the backup")
	}
	before := w.revision.Load()
	dir := filepath.Join(w.root, "new")
	if err := os.Mkdir(dir, 0755); err != nil {
		t.Fatal(err)
	}
	waitChange(before)
	// Synchronize with the watcher completing its recursive watch registration.
	time.Sleep(600 * time.Millisecond)
	before = w.revision.Load()
	if err := os.WriteFile(filepath.Join(dir, "temporary"), []byte("saved"), 0644); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(filepath.Join(dir, "temporary"), filepath.Join(dir, "file.txt")); err != nil {
		t.Fatal(err)
	}
	waitChange(before)
}
