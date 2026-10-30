package main

import (
	ocispec "github.com/opencontainers/image-spec/specs-go/v1"
	"testing"
)

func TestBrowserGuestCapabilitiesDoNotInheritBuildContainerLimits(t *testing.T) {
	spec, err := generateSpec(ocispec.Image{Platform: ocispec.Platform{Architecture: "amd64"}, Config: ocispec.ImageConfig{Entrypoint: []string{"/bin/bash"}}}, t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	for name, values := range map[string][]string{"bounding": spec.Process.Capabilities.Bounding, "effective": spec.Process.Capabilities.Effective, "permitted": spec.Process.Capabilities.Permitted} {
		for _, required := range []string{"CAP_SYS_ADMIN", "CAP_NET_ADMIN", "CAP_MKNOD", "CAP_SETPCAP"} {
			found := false
			for _, value := range values {
				if value == required {
					found = true
				}
			}
			if !found {
				t.Errorf("guest %s capabilities lack %s", name, required)
			}
		}
	}
	if len(spec.Linux.MaskedPaths) != 0 || len(spec.Linux.ReadonlyPaths) != 0 {
		t.Fatal("Docker's guest kernel interfaces are masked")
	}
	for _, mount := range spec.Mounts {
		if mount.Destination == "/sys/fs/cgroup" {
			for _, option := range mount.Options {
				if option == "ro" {
					t.Fatal("guest cgroup filesystem is read-only")
				}
			}
		}
	}
}
