//go:build !linux

package main

import "errors"

func watchWorkspace(*workspace) error { return errors.New("workspace watching requires Linux") }
