package home

import (
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
	Language        string
}

func envValue(name, fallback string) string {
	if value, ok := os.LookupEnv(name); ok {
		return value
	}
	return fallback
}

func ParseConfig(args []string) (Config, error) {
	var c Config
	f := flag.NewFlagSet("lingshu-home", flag.ContinueOnError)
	f.StringVar(&c.Listen, "listen", envValue("LINGSHU_LISTEN", "127.0.0.1:5180"), "HTTP listening address")
	f.StringVar(&c.DataDir, "data-dir", envValue("LINGSHU_DATA_DIR", "data"), "Persistent data and key directory")
	f.StringVar(&c.StorageProvider, "storage-provider", envValue("LINGSHU_STORAGE_PROVIDER", "sqlite"), "sqlite or postgres")
	f.StringVar(&c.DatabaseURL, "database-url", envValue("LINGSHU_DATABASE_URL", ""), "PostgreSQL connection URL; prefer environment")
	f.StringVar(&c.WebDir, "web-dir", envValue("LINGSHU_WEB_DIR", "web/dist"), "Built frontend directory")
	f.StringVar(&c.VersionFile, "version-file", envValue("LINGSHU_VERSION_FILE", "VERSION"), "Product VERSION file")
	f.StringVar(&c.Language, "language", envValue("LINGSHU_LANGUAGE", "zh-CN"), "Instance interface language: zh-CN or en")
	secure, err := strconv.ParseBool(envValue("LINGSHU_SECURE_COOKIES", "false"))
	if err != nil {
		return c, errors.New("LINGSHU_SECURE_COOKIES must be true or false")
	}
	f.BoolVar(&c.SecureCookies, "secure-cookies", secure, "Require HTTPS cookies")
	if err := f.Parse(args); err != nil {
		return c, err
	}
	if f.NArg() != 0 {
		return c, errors.New("unexpected positional arguments")
	}
	return c, c.validate()
}

func (c *Config) validate() error {
	switch c.Language {
	case "", "zh-CN":
		c.Language = "zh-CN"
	case "en":
		c.Language = "en"
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
	return err
}
