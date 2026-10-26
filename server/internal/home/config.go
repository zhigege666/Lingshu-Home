package home

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"os"
	"path/filepath"
	"strconv"
	"strings"
)

type Config struct {
	Listen          string
	DataDir         string
	StorageProvider string
	DatabaseURL     string
	WebDir          string
	VersionFile     string
	SecureCookies   bool
	TLSCertFile     string
	TLSKeyFile      string
	Language        string
	DocumentRoots   []string
	storageSource   string
	runtimeLease    *fileLease
	runtimeContext  context.Context
}

func envValue(name, fallback string) string {
	if value, ok := os.LookupEnv(name); ok {
		return value
	}
	return fallback
}

func ParseConfig(args []string) (Config, error) {
	var c Config
	var documentRoots string
	f := flag.NewFlagSet("lingshu-home", flag.ContinueOnError)
	f.StringVar(&c.Listen, "listen", envValue("LINGSHU_LISTEN", "127.0.0.1:5180"), "HTTP or HTTPS listening address")
	f.StringVar(&c.DataDir, "data-dir", envValue("LINGSHU_DATA_DIR", "data"), "Persistent data and key directory")
	f.StringVar(&c.StorageProvider, "storage-provider", envValue("LINGSHU_STORAGE_PROVIDER", "sqlite"), "sqlite or postgres")
	f.StringVar(&c.DatabaseURL, "database-url", "", "PostgreSQL connection URL; prefer environment")
	f.StringVar(&c.WebDir, "web-dir", envValue("LINGSHU_WEB_DIR", "web/dist"), "Built frontend directory")
	f.StringVar(&c.VersionFile, "version-file", envValue("LINGSHU_VERSION_FILE", "VERSION"), "Product VERSION file")
	f.StringVar(&c.Language, "language", envValue("LINGSHU_LANGUAGE", ""), "Initial instance language: zh-CN or en; omit to choose during setup")
	secure, err := strconv.ParseBool(envValue("LINGSHU_SECURE_COOKIES", "false"))
	if err != nil {
		return c, errors.New("LINGSHU_SECURE_COOKIES must be true or false")
	}
	f.BoolVar(&c.SecureCookies, "secure-cookies", secure, "Require HTTPS cookies")
	f.StringVar(&c.TLSCertFile, "tls-cert-file", envValue("LINGSHU_TLS_CERT_FILE", ""), "PEM certificate chain for direct HTTPS; requires tls-key-file")
	f.StringVar(&c.TLSKeyFile, "tls-key-file", envValue("LINGSHU_TLS_KEY_FILE", ""), "PEM private key for direct HTTPS; requires tls-cert-file")
	f.StringVar(&documentRoots, "document-roots", envValue("LINGSHU_DOCUMENT_ROOTS", "[]"), "JSON array of allowed absolute document directories; disabled by default")
	if err := f.Parse(args); err != nil {
		return c, err
	}
	if f.NArg() != 0 {
		return c, errors.New("unexpected positional arguments")
	}
	if err := json.Unmarshal([]byte(documentRoots), &c.DocumentRoots); err != nil {
		return c, errors.New("LINGSHU_DOCUMENT_ROOTS must be a JSON array of absolute directory paths")
	}
	provided := map[string]bool{}
	f.Visit(func(item *flag.Flag) { provided[item.Name] = true })
	if !provided["database-url"] {
		c.DatabaseURL = envValue("LINGSHU_DATABASE_URL", "")
	}
	providerEnv := strings.TrimSpace(envValue("LINGSHU_STORAGE_PROVIDER", ""))
	urlEnv := strings.TrimSpace(envValue("LINGSHU_DATABASE_URL", ""))
	c.storageSource = "default"
	if provided["storage-provider"] || provided["database-url"] {
		c.storageSource = "cli"
	} else if providerEnv != "" || urlEnv != "" {
		c.storageSource = "environment"
	}
	if provided["storage-provider"] && strings.TrimSpace(c.StorageProvider) == "" {
		return c, errors.New("storage provider must be sqlite or postgres")
	}
	if !provided["storage-provider"] && providerEnv == "" && strings.TrimSpace(c.DatabaseURL) != "" {
		c.StorageProvider = "postgres"
	}
	return c, c.validate()
}

func (c *Config) validate() error {
	if (c.TLSCertFile == "") != (c.TLSKeyFile == "") {
		return errors.New("TLS certificate and key must be configured together (LINGSHU_TLS_CERT_FILE / LINGSHU_TLS_KEY_FILE)")
	}
	switch c.Language {
	case "", "zh-CN", "en":
	default:
		return errors.New("unsupported language: choose zh-CN or en")
	}
	if c.Listen == "" {
		c.Listen = "127.0.0.1:5180"
	}
	if c.DataDir == "" {
		c.DataDir = "data"
	}
	if c.StorageProvider == "" {
		c.StorageProvider = "sqlite"
	}
	if c.VersionFile == "" {
		c.VersionFile = "VERSION"
	}
	if c.WebDir == "" {
		c.WebDir = "web/dist"
	}
	c.StorageProvider = strings.ToLower(c.StorageProvider)
	if c.StorageProvider != "sqlite" && c.StorageProvider != "postgres" {
		return errors.New("unsupported storage provider: choose sqlite or postgres")
	}
	if c.StorageProvider == "postgres" && strings.TrimSpace(c.DatabaseURL) == "" {
		return errors.New("LINGSHU_DATABASE_URL is required for postgres")
	}
	var err error
	c.DataDir, err = filepath.Abs(c.DataDir)
	if err != nil {
		return err
	}
	return c.validateDocumentRoots()
}
