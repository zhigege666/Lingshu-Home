package main

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/zhigege666/Lingshu-Home/server/internal/home"
)

func main() {
	// Keep os.Exit outside the scope that owns App: run's deferred cleanup
	// must execute for listener failures as well as signal-driven shutdown.
	os.Exit(run(os.Args[1:]))
}

func run(args []string) (exitCode int) {
	c, err := home.ParseConfig(args)
	if err != nil {
		log.Print(err)
		return 2
	}
	// Validate and load both files before opening the business store. A bad
	// HTTPS configuration must neither initialize data nor fall back to HTTP.
	tlsConfig, err := loadServerTLS(c)
	if err != nil {
		log.Printf("TLS startup failed: %v", err)
		return 1
	}
	app, err := home.Open(c)
	if err != nil {
		log.Printf("startup failed: %v", err)
		return 1
	}
	defer func() {
		if err := app.Close(); err != nil {
			log.Printf("application shutdown failed: %v", err)
			exitCode = 1
		}
	}()
	server := &http.Server{Addr: c.Listen, Handler: app, TLSConfig: tlsConfig, ReadHeaderTimeout: 10 * time.Second, ReadTimeout: 30 * time.Second, IdleTimeout: 90 * time.Second, MaxHeaderBytes: 64 * 1024}
	protocol, serve := "HTTP", server.ListenAndServe
	if tlsConfig != nil {
		protocol = "HTTPS"
		serve = func() error { return server.ListenAndServeTLS("", "") }
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	log.Printf("Lingshu-Home %s listening on %s (%s)", protocol, c.Listen, c.StorageProvider)
	if err = serveHTTP(ctx, server, serve, 15*time.Second); err != nil {
		log.Printf("%s server failed: %v", protocol, err)
		return 1
	}
	return 0
}

func loadServerTLS(c home.Config) (*tls.Config, error) {
	if c.TLSCertFile == "" && c.TLSKeyFile == "" {
		return nil, nil
	}
	if c.TLSCertFile == "" || c.TLSKeyFile == "" {
		return nil, errors.New("TLS certificate and key must be configured together")
	}
	certificate, err := tls.LoadX509KeyPair(c.TLSCertFile, c.TLSKeyFile)
	if err != nil {
		return nil, fmt.Errorf("load certificate and private key: %w", err)
	}
	return &tls.Config{MinVersion: tls.VersionTLS12, Certificates: []tls.Certificate{certificate}}, nil
}

// serveHTTP owns the join between the serving loop and graceful shutdown.
// ListenAndServe/Serve returns ErrServerClosed as soon as listeners close;
// App must remain open until Shutdown has also finished draining requests.
// serve is a standard http.Server serving method; tests use Serve with a
// pre-bound loopback listener so no fixed service port is needed.
func serveHTTP(ctx context.Context, server *http.Server, serve func() error, timeout time.Duration) error {
	served := make(chan error, 1)
	go func() { served <- serve() }()

	var serveErr error
	serveStopped := false
	select {
	case serveErr = <-served:
		// A failed listener must not wait for a signal. Shutdown also drains
		// any remaining requests if an established listener failed later.
		serveStopped = true
	case <-ctx.Done():
	}

	shutdown, cancel := context.WithTimeout(context.Background(), timeout)
	shutdownErr := server.Shutdown(shutdown)
	cancel()
	var closeErr error
	if shutdownErr != nil {
		// Close cancels active connections but is not a join for handlers
		// that ignore cancellation. Report the forced path as a failure;
		// do not wait without a bound or claim a successful graceful drain.
		closeErr = server.Close()
		shutdownErr = fmt.Errorf("graceful HTTP shutdown failed; forced connection close attempted: %w", shutdownErr)
		if closeErr != nil {
			closeErr = fmt.Errorf("forced HTTP connection close failed: %w", closeErr)
		}
	}
	if !serveStopped {
		serveErr = <-served
	}
	if errors.Is(serveErr, http.ErrServerClosed) {
		serveErr = nil
	}
	return errors.Join(serveErr, shutdownErr, closeErr)
}
