//go:build !windows

package home

import (
	"errors"
	"golang.org/x/sys/unix"
	"os"
)

type fileLease struct{ file *os.File }

func acquireFileLease(path string) (*fileLease, error) {
	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return nil, err
	}
	if err = unix.Flock(int(f.Fd()), unix.LOCK_EX|unix.LOCK_NB); err != nil {
		f.Close()
		return nil, errors.New("another instance already uses this data directory")
	}
	return &fileLease{file: f}, nil
}

func (l *fileLease) Close() error {
	_ = unix.Flock(int(l.file.Fd()), unix.LOCK_UN)
	return l.file.Close()
}
