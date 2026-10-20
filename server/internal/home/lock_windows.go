//go:build windows

package home

import (
	"errors"
	"golang.org/x/sys/windows"
	"os"
)

type fileLease struct {
	file       *os.File
	overlapped windows.Overlapped
}

func acquireFileLease(path string) (*fileLease, error) {
	f, err := os.OpenFile(path, os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return nil, err
	}
	l := &fileLease{file: f}
	err = windows.LockFileEx(windows.Handle(f.Fd()), windows.LOCKFILE_EXCLUSIVE_LOCK|windows.LOCKFILE_FAIL_IMMEDIATELY, 0, 1, 0, &l.overlapped)
	if err != nil {
		f.Close()
		return nil, errors.New("another instance already uses this data directory")
	}
	return l, nil
}

func (l *fileLease) Close() error {
	_ = windows.UnlockFileEx(windows.Handle(l.file.Fd()), 0, 1, 0, &l.overlapped)
	return l.file.Close()
}
