package main

import (
	"encoding/binary"
	"io/fs"
	"path/filepath"
	"syscall"
	"time"
)

func watchWorkspace(w *workspace) error {
	fd, err := syscall.InotifyInit1(syscall.IN_CLOEXEC | syscall.IN_NONBLOCK)
	if err != nil {
		return err
	}
	add := func() error {
		return filepath.WalkDir(w.root, func(path string, entry fs.DirEntry, err error) error {
			if err != nil {
				w.watchFailed.Store(true)
				return err
			}
			if entry.IsDir() {
				_, err = syscall.InotifyAddWatch(fd, path, syscall.IN_CLOSE_WRITE|syscall.IN_CREATE|syscall.IN_DELETE|syscall.IN_MOVED_FROM|syscall.IN_MOVED_TO|syscall.IN_ATTRIB|syscall.IN_DELETE_SELF|syscall.IN_MOVE_SELF)
			}
			return err
		})
	}
	if err := add(); err != nil {
		syscall.Close(fd)
		return err
	}
	go func() {
		buffer := make([]byte, 64<<10)
		for {
			n, err := syscall.Read(fd, buffer)
			if err == syscall.EAGAIN || err == syscall.EINTR {
				time.Sleep(500 * time.Millisecond)
				continue
			}
			if err != nil {
				w.revision.Add(1)
				time.Sleep(time.Second)
				continue
			}
			if n == 0 {
				time.Sleep(500 * time.Millisecond)
				continue
			}
			w.revision.Add(1)
			rescan := false
			for offset := 0; offset+16 <= n; {
				mask := binary.LittleEndian.Uint32(buffer[offset+4:])
				length := int(binary.LittleEndian.Uint32(buffer[offset+12:]))
				if mask&(syscall.IN_CREATE|syscall.IN_MOVED_TO|syscall.IN_Q_OVERFLOW) != 0 {
					rescan = true
				}
				offset += 16 + length
			}
			if rescan {
				w.mu.Lock()
				if err := add(); err != nil {
					w.watchFailed.Store(true)
				}
				w.mu.Unlock()
			}
		}
	}()
	return nil
}
