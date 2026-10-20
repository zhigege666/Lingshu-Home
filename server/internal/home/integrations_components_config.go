package home

import (
	"encoding/json"
	"net/url"
	"strconv"
	"strings"
)

func integrationPollingKind(kind string) bool {
	return oneOf(kind, "github-traffic", "calendar-ics", "weather-open-meteo", "external-json")
}
func integrationSecretRequired(kind string, connection map[string]string) bool {
	return oneOf(kind, "github-traffic", "calendar-ics", "external-json") || (kind == "weather-open-meteo" && connection["provider"] == "open-meteo-commercial")
}
func integrationSecretEmpty(s *integrationSecretInput) bool {
	return s == nil || (s.Token == "" && s.URL == "" && s.BearerToken == "" && s.APIKey == "" && !s.ClearBearerToken)
}
func integrationSecretPlain(kind string, s *integrationSecretInput) string {
	if kind == "github-traffic" {
		return s.Token
	}
	clean := *s
	clean.ClearBearerToken = false
	b, _ := json.Marshal(clean)
	return string(b)
}
func integrationHasRequiredSecret(kind string, connection map[string]string, s *integrationSecretInput) bool {
	if !integrationSecretRequired(kind, connection) {
		return true
	}
	if s == nil {
		return false
	}
	switch kind {
	case "github-traffic":
		return s.Token != ""
	case "weather-open-meteo":
		return s.APIKey != ""
	default:
		return s.URL != ""
	}
}
func (a *App) mergeIntegrationSecret(source IntegrationSource, input *integrationSecretInput) (string, error) {
	if source.Kind == "github-traffic" {
		return input.Token, nil
	}
	var merged integrationSecretInput
	if source.credentialCipher != "" {
		raw, err := a.decryptIntegrationSecret(source.ID, source.credentialCipher)
		if err != nil {
			return "", err
		}
		if err = json.Unmarshal([]byte(raw), &merged); err != nil {
			return "", invalid("source credential is unavailable")
		}
	}
	if input.URL != "" && merged.URL != "" && merged.BearerToken != "" && input.BearerToken == "" && !input.ClearBearerToken && !integrationSameOrigin(input.URL, merged.URL) {
		return "", invalid("changing a source origin requires a replacement bearer token or explicit clearBearerToken")
	}
	if input.ClearBearerToken {
		merged.BearerToken = ""
	}
	merged.ClearBearerToken = false
	if input.URL != "" {
		merged.URL = input.URL
	}
	if input.APIKey != "" {
		merged.APIKey = input.APIKey
	}
	if input.BearerToken != "" {
		merged.BearerToken = input.BearerToken
	}
	if !integrationHasRequiredSecret(source.Kind, source.Connection, &merged) {
		return "", invalid("source credential is incomplete")
	}
	return integrationSecretPlain(source.Kind, &merged), nil
}
func integrationConnectionKeys(connection map[string]string, keys ...string) bool {
	for key, value := range connection {
		if len(value) > 512 || strings.ContainsAny(value, "\x00\r\n") {
			return false
		}
		found := false
		for _, allowed := range keys {
			if key == allowed {
				found = true
				break
			}
		}
		if !found {
			return false
		}
	}
	return true
}
func integrationConfigInt(connection map[string]string, name string, fallback, low, high int) (int, error) {
	if connection[name] == "" {
		connection[name] = strconv.Itoa(fallback)
	}
	n, err := strconv.Atoi(connection[name])
	if err != nil || n < low || n > high || strconv.Itoa(n) != connection[name] {
		return 0, invalid("invalid source configuration: " + name)
	}
	return n, nil
}
func validateComponentConfiguration(kind, schema string, c map[string]string, syncConfig *IntegrationSync, secret *integrationSecretInput) error {
	if syncConfig.Mode != "poll" {
		return invalid("this source requires poll mode")
	}
	interval, minimum := 60, 30
	switch kind {
	case "calendar-ics":
		if schema != "calendar.events" || !integrationConnectionKeys(c, "timezone", "pastDays", "futureDays", "allowPrivateNetwork") {
			return invalid("calendar-ics requires calendar.events@1 and a calendar connection")
		}
		if _, err := integrationTimezone(c["timezone"]); err != nil {
			return err
		}
		past, err := integrationConfigInt(c, "pastDays", 1, 0, 30)
		if err != nil {
			return err
		}
		future, err := integrationConfigInt(c, "futureDays", 30, 1, 90)
		if err != nil {
			return err
		}
		if past+future > 90 {
			return invalid("calendar time window cannot exceed 90 days")
		}
		interval, minimum = 900, 300
	case "weather-open-meteo":
		if schema != "weather.forecast" || !integrationConnectionKeys(c, "latitude", "longitude", "timezone", "forecastDays", "provider", "locationName", "temperatureUnit", "windSpeedUnit") {
			return invalid("weather-open-meteo requires weather.forecast@1 and a weather connection")
		}
		latitude, e1 := strconv.ParseFloat(c["latitude"], 64)
		longitude, e2 := strconv.ParseFloat(c["longitude"], 64)
		if e1 != nil || e2 != nil || !integrationFinite(latitude) || !integrationFinite(longitude) || latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180 {
			return invalid("latitude and longitude must be valid decimal coordinates")
		}
		if _, err := integrationTimezone(c["timezone"]); err != nil {
			return err
		}
		if _, err := integrationConfigInt(c, "forecastDays", 7, 1, 7); err != nil {
			return err
		}
		if c["provider"] == "" {
			c["provider"] = "open-meteo"
		}
		if !oneOf(c["provider"], "open-meteo", "open-meteo-commercial") {
			return invalid("unsupported weather provider")
		}
		if (c["temperatureUnit"] != "" && c["temperatureUnit"] != "celsius") || (c["windSpeedUnit"] != "" && c["windSpeedUnit"] != "kmh") || len(c["locationName"]) > 120 {
			return invalid("weather uses celsius and kmh units")
		}
		c["temperatureUnit"], c["windSpeedUnit"] = "celsius", "kmh"
		interval, minimum = 1800, 900
	case "external-json":
		if !integrationComponentSchema(schema) || !integrationConnectionKeys(c, "schemaId", "schemaVersion", "allowPrivateNetwork") {
			return invalid("external-json requires one of the four component schemas")
		}
		if c["schemaId"] == "" {
			c["schemaId"] = schema
		}
		if c["schemaVersion"] == "" {
			c["schemaVersion"] = "1"
		}
		if c["schemaId"] != schema || c["schemaVersion"] != "1" {
			return invalid("connection schema must match the source")
		}
	default:
		return invalid("unsupported source kind")
	}
	if kind != "weather-open-meteo" {
		if c["allowPrivateNetwork"] == "" {
			c["allowPrivateNetwork"] = "false"
		}
		if !oneOf(c["allowPrivateNetwork"], "true", "false") {
			return invalid("allowPrivateNetwork must be true or false")
		}
	}
	if syncConfig.IntervalSeconds == 0 {
		syncConfig.IntervalSeconds = interval
	}
	if syncConfig.IntervalSeconds < minimum || syncConfig.IntervalSeconds > 604800 {
		return invalid("poll interval is outside the adapter's allowed range")
	}
	if syncConfig.StaleAfterSeconds == 0 {
		syncConfig.StaleAfterSeconds = 2 * syncConfig.IntervalSeconds
	}
	if secret != nil {
		if secret.Token != "" {
			return invalid("token is only supported by github-traffic")
		}
		if secret.ClearBearerToken && (kind != "external-json" || secret.BearerToken != "") {
			return invalid("clearBearerToken is only valid for external-json without a replacement token")
		}
		if kind == "weather-open-meteo" {
			if secret.URL != "" || secret.BearerToken != "" || len(secret.APIKey) > 512 || strings.ContainsAny(secret.APIKey, " \t\r\n\x00") {
				return invalid("invalid weather API key")
			}
			if c["provider"] == "open-meteo" && secret.APIKey != "" {
				return invalid("API keys require the commercial weather provider")
			}
		} else {
			if secret.APIKey != "" || len(secret.BearerToken) > 2048 || strings.ContainsAny(secret.BearerToken, "\r\n\x00") {
				return invalid("invalid external source credentials")
			}
			if kind == "calendar-ics" && secret.BearerToken != "" {
				return invalid("calendar-ics accepts a secret subscription URL")
			}
			if secret.URL != "" {
				if _, err := integrationRemoteURL(secret.URL, c["allowPrivateNetwork"] == "true"); err != nil {
					return err
				}
			}
		}
	}
	return nil
}

func integrationSameOrigin(a, b string) bool {
	left, e1 := canonicalURL(a)
	right, e2 := canonicalURL(b)
	if e1 != nil || e2 != nil {
		return false
	}
	u, e1 := url.Parse(left)
	v, e2 := url.Parse(right)
	if e1 != nil || e2 != nil {
		return false
	}
	return u.Scheme == v.Scheme && strings.EqualFold(strings.TrimSuffix(u.Hostname(), "."), strings.TrimSuffix(v.Hostname(), ".")) && u.Port() == v.Port()
}
