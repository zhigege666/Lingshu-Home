package home

import "testing"

func TestTLSConfigRequiresPairAndAllowsExplicitFlagOverride(t *testing.T) {
	t.Setenv("LINGSHU_STORAGE_PROVIDER", "sqlite")
	t.Setenv("LINGSHU_SECURE_COOKIES", "false")
	t.Setenv("LINGSHU_LANGUAGE", "en")
	t.Setenv("LINGSHU_DATA_DIR", t.TempDir())
	for _, test := range []struct {
		name, cert, key, wantCert, wantKey string
		args                               []string
		invalid                            bool
	}{
		{name: "default HTTP"},
		{name: "certificate only", cert: "/cert.pem", invalid: true},
		{name: "key only", key: "/key.pem", invalid: true},
		{name: "environment pair", cert: "/cert.pem", key: "/key.pem", wantCert: "/cert.pem", wantKey: "/key.pem"},
		{name: "flag pair", args: []string{"--tls-cert-file", "/flag-cert.pem", "--tls-key-file", "/flag-key.pem"}, wantCert: "/flag-cert.pem", wantKey: "/flag-key.pem"},
		{name: "flags override environment", cert: "/env-cert.pem", key: "/env-key.pem", args: []string{"--tls-cert-file", "/flag-cert.pem", "--tls-key-file", "/flag-key.pem"}, wantCert: "/flag-cert.pem", wantKey: "/flag-key.pem"},
		{name: "explicitly clear both", cert: "/cert.pem", key: "/key.pem", args: []string{"--tls-cert-file=", "--tls-key-file="}},
		{name: "cannot clear one", cert: "/cert.pem", key: "/key.pem", args: []string{"--tls-key-file="}, invalid: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			t.Setenv("LINGSHU_TLS_CERT_FILE", test.cert)
			t.Setenv("LINGSHU_TLS_KEY_FILE", test.key)
			config, err := ParseConfig(test.args)
			if test.invalid {
				if err == nil {
					t.Fatal("incomplete TLS configuration was accepted")
				}
				return
			}
			if err != nil || config.TLSCertFile != test.wantCert || config.TLSKeyFile != test.wantKey {
				t.Fatalf("cert=%q key=%q error=%v; want cert=%q key=%q", config.TLSCertFile, config.TLSKeyFile, err, test.wantCert, test.wantKey)
			}
		})
	}
}
