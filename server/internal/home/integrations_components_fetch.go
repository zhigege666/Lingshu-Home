package home

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"math"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"strconv"
	"strings"
	"time"

	"golang.org/x/net/idna"
)

func integrationAllowedAddress(ip netip.Addr, private bool) bool {
	if !ip.IsValid() || ip.Zone() != "" {
		return false
	}
	ip = ip.Unmap()
	if iconPublicIP(ip) {
		return true
	}
	// Enabling private networks permits RFC1918/ULA only, never loopback,
	// link-local, cloud metadata, CGNAT or reserved/transition networks.
	if !private || !ip.IsPrivate() || !ip.IsGlobalUnicast() || ip.IsLoopback() || ip.IsLinkLocalUnicast() {
		return false
	}
	return ip != netip.MustParseAddr("fd00:ec2::254")
}
func integrationRemoteURL(raw string, private bool) (*url.URL, error) {
	original, parseErr := url.Parse(raw)
	if parseErr != nil || original.Fragment != "" {
		return nil, invalid("external source URL must not contain a fragment")
	}
	canonical, err := canonicalURL(raw)
	if err != nil {
		return nil, invalid("invalid external source URL")
	}
	u, err := url.Parse(canonical)
	if err != nil || u.User != nil || u.Fragment != "" {
		return nil, invalid("external source URL must not contain user info or a fragment")
	}
	host := strings.TrimSuffix(strings.ToLower(u.Hostname()), ".")
	if ip, e := netip.ParseAddr(host); e == nil {
		if !integrationAllowedAddress(ip, private) {
			return nil, invalid("external source address is blocked")
		}
	} else {
		host, err = idna.Lookup.ToASCII(host)
		if err != nil || host == "" || len(host) > 253 || strings.ContainsAny(host, "%\\\x00") {
			return nil, invalid("invalid external source hostname")
		}
		for _, blocked := range []string{"localhost", "metadata", "metadata.google.internal", "instance-data", "metadata.tencentyun.com"} {
			if host == blocked || strings.HasSuffix(host, "."+blocked) {
				return nil, invalid("external source hostname is blocked")
			}
		}
		if !private {
			for _, suffix := range []string{".local", ".internal", ".lan", ".home", ".test", ".invalid", ".example", ".onion"} {
				if strings.HasSuffix(host, suffix) {
					return nil, invalid("private source requires explicit private-network permission")
				}
			}
		}
		for _, label := range strings.Split(host, ".") {
			if label == "" || len(label) > 63 || label[0] == '-' || label[len(label)-1] == '-' {
				return nil, invalid("invalid external source hostname")
			}
			for _, ch := range label {
				if ch != '-' && (ch < 'a' || ch > 'z') && (ch < '0' || ch > '9') {
					return nil, invalid("invalid external source hostname")
				}
			}
		}
	}
	port := u.Port()
	if port != "" {
		n, e := strconv.Atoi(port)
		if e != nil || n < 1 || n > 65535 {
			return nil, invalid("invalid external source port")
		}
	}
	if port != "" {
		u.Host = net.JoinHostPort(host, port)
	} else if strings.Contains(host, ":") {
		u.Host = "[" + host + "]"
	} else {
		u.Host = host
	}
	return u, nil
}
func integrationPinnedDial(resolver iconIPResolver, dial iconDialContext, private bool) iconDialContext {
	return func(ctx context.Context, network, address string) (net.Conn, error) {
		if network != "tcp" && network != "tcp4" && network != "tcp6" {
			return nil, errors.New("unsupported source network")
		}
		host, port, err := net.SplitHostPort(address)
		if err != nil {
			return nil, errors.New("invalid source address")
		}
		var ips []netip.Addr
		if ip, e := netip.ParseAddr(host); e == nil {
			ips = []netip.Addr{ip}
		} else {
			ips, err = resolver.LookupNetIP(ctx, "ip", host)
			if err != nil {
				return nil, errors.New("source address lookup failed")
			}
		}
		if len(ips) == 0 || len(ips) > 16 {
			return nil, errors.New("source address lookup is empty or excessive")
		}
		for _, ip := range ips {
			if !integrationAllowedAddress(ip, private) {
				return nil, errors.New("source resolves to a blocked address")
			}
		}
		for _, ip := range ips {
			conn, e := dial(ctx, "tcp", net.JoinHostPort(ip.Unmap().String(), port))
			if e == nil {
				return conn, nil
			}
			if ctx.Err() != nil {
				break
			}
		}
		return nil, errors.New("source connection failed")
	}
}
func integrationHTTPClient(private bool) *http.Client {
	d := &net.Dialer{Timeout: 4 * time.Second, KeepAlive: -1}
	return integrationHTTPClientWithDial(private, d.DialContext)
}
func integrationHTTPClientWithDial(private bool, dial iconDialContext) *http.Client {
	t := &http.Transport{Proxy: nil, DialContext: integrationPinnedDial(net.DefaultResolver, dial, private), DisableKeepAlives: true, DisableCompression: true, TLSHandshakeTimeout: 4 * time.Second, ResponseHeaderTimeout: 8 * time.Second, MaxResponseHeaderBytes: 32 << 10}
	return &http.Client{Transport: t, Timeout: 15 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
}
func componentIntegrationFailure(code string) *IntegrationFailure {
	return &IntegrationFailure{Code: code, Message: "The source could not be refreshed. Check its configuration, network policy and upstream availability.", At: time.Now().UTC()}
}
func fetchIntegrationBody(ctx context.Context, client *http.Client, raw string, private bool, bearer string) ([]byte, *IntegrationFailure) {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	target, err := integrationRemoteURL(raw, private)
	if err != nil {
		return nil, componentIntegrationFailure("source_address_blocked")
	}
	originScheme, originHost := target.Scheme, target.Host
	for hop := 0; hop < 4; hop++ {
		req, e := http.NewRequestWithContext(ctx, http.MethodGet, target.String(), nil)
		if e != nil {
			return nil, componentIntegrationFailure("source_invalid_request")
		}
		req.Header.Set("Accept", "application/json, text/calendar;q=0.9")
		req.Header.Set("Accept-Encoding", "identity")
		req.Header.Set("User-Agent", "Lingshu-Home/components")
		if bearer != "" {
			req.Header.Set("Authorization", "Bearer "+bearer)
		}
		resp, e := client.Do(req)
		if e != nil {
			return nil, componentIntegrationFailure("source_unreachable")
		}
		if oneOf(strconv.Itoa(resp.StatusCode), "301", "302", "303", "307", "308") {
			location := resp.Header.Get("Location")
			resp.Body.Close()
			next, e := target.Parse(location)
			if e != nil || location == "" {
				return nil, componentIntegrationFailure("source_invalid_redirect")
			}
			target, e = integrationRemoteURL(next.String(), private)
			if e != nil || target.Scheme != originScheme || target.Host != originHost {
				return nil, componentIntegrationFailure("source_redirect_blocked")
			}
			continue
		}
		if resp.StatusCode != http.StatusOK {
			resp.Body.Close()
			return nil, componentIntegrationFailure("source_http_" + strconv.Itoa(resp.StatusCode))
		}
		if encoding := resp.Header.Get("Content-Encoding"); encoding != "" && encoding != "identity" {
			resp.Body.Close()
			return nil, componentIntegrationFailure("source_encoding_unsupported")
		}
		body, e := io.ReadAll(io.LimitReader(resp.Body, (1<<20)+1))
		resp.Body.Close()
		if e != nil || len(body) > 1<<20 {
			return nil, componentIntegrationFailure("source_response_too_large_or_incomplete")
		}
		return body, nil
	}
	return nil, componentIntegrationFailure("source_redirect_limit")
}

func weatherIntegrationURL(s IntegrationSource, secret integrationSecretInput) string {
	host := "api.open-meteo.com"
	if s.Connection["provider"] == "open-meteo-commercial" {
		host = "customer-api.open-meteo.com"
	}
	u := url.URL{Scheme: "https", Host: host, Path: "/v1/forecast"}
	q := url.Values{"latitude": {s.Connection["latitude"]}, "longitude": {s.Connection["longitude"]}, "timezone": {s.Connection["timezone"]}, "forecast_days": {s.Connection["forecastDays"]}, "timeformat": {"unixtime"}, "temperature_unit": {"celsius"}, "wind_speed_unit": {"kmh"}, "current": {"temperature_2m,apparent_temperature,relative_humidity_2m,weather_code,wind_speed_10m,is_day"}, "daily": {"temperature_2m_max,temperature_2m_min,weather_code,sunrise,sunset,precipitation_probability_max"}}
	if s.Connection["provider"] == "open-meteo-commercial" {
		q.Set("apikey", secret.APIKey)
	}
	u.RawQuery = q.Encode()
	return u.String()
}
func normalizeOpenMeteo(raw []byte, source IntegrationSource) (WeatherData, error) {
	var upstream struct {
		UTCOffsetSeconds *int `json:"utc_offset_seconds"`
		Current          *struct {
			Time        *int64   `json:"time"`
			Temperature *float64 `json:"temperature_2m"`
			Apparent    *float64 `json:"apparent_temperature"`
			Code        *int     `json:"weather_code"`
			Humidity    *float64 `json:"relative_humidity_2m"`
			Wind        *float64 `json:"wind_speed_10m"`
			IsDay       *int     `json:"is_day"`
		} `json:"current"`
		Daily struct {
			Time        []int64    `json:"time"`
			Code        []*int     `json:"weather_code"`
			Max         []*float64 `json:"temperature_2m_max"`
			Min         []*float64 `json:"temperature_2m_min"`
			Sunrise     []*int64   `json:"sunrise"`
			Sunset      []*int64   `json:"sunset"`
			Probability []*float64 `json:"precipitation_probability_max"`
		} `json:"daily"`
	}
	d := WeatherData{Timezone: source.Connection["timezone"], LocationName: source.Connection["locationName"], Daily: []WeatherDay{}}
	d.Latitude, _ = strconv.ParseFloat(source.Connection["latitude"], 64)
	d.Longitude, _ = strconv.ParseFloat(source.Connection["longitude"], 64)
	_, err := integrationTimezone(d.Timezone)
	if err != nil {
		return d, err
	}
	if err = json.Unmarshal(raw, &upstream); err != nil {
		return d, invalid("invalid weather response")
	}
	if upstream.UTCOffsetSeconds == nil || *upstream.UTCOffsetSeconds < -14*3600 || *upstream.UTCOffsetSeconds > 14*3600 {
		return d, invalid("weather response requires a valid provider UTC offset")
	}
	c := upstream.Current
	if c == nil || c.Time == nil || c.Temperature == nil || c.Code == nil || c.IsDay == nil || (*c.IsDay != 0 && *c.IsDay != 1) {
		return d, invalid("weather response is missing current observations")
	}
	d.Current = &WeatherCurrent{Time: *c.Time, Temperature: *c.Temperature, ApparentTemperature: c.Apparent, WeatherCode: *c.Code, Humidity: c.Humidity, WindSpeed: c.Wind, IsDay: *c.IsDay == 1}
	u := upstream.Daily
	n := len(u.Time)
	if n == 0 || n > 7 || len(u.Code) != n || len(u.Max) != n || len(u.Min) != n || (len(u.Sunrise) != 0 && len(u.Sunrise) != n) || (len(u.Sunset) != 0 && len(u.Sunset) != n) || (len(u.Probability) != 0 && len(u.Probability) != n) {
		return d, invalid("weather daily arrays have inconsistent lengths")
	}
	for i, stamp := range u.Time {
		if stamp <= 0 || u.Code[i] == nil || u.Max[i] == nil || u.Min[i] == nil {
			return d, invalid("weather response is missing daily observations")
		}
		day := WeatherDay{Date: time.Unix(stamp+int64(*upstream.UTCOffsetSeconds), 0).UTC().Format("2006-01-02"), WeatherCode: *u.Code[i], TemperatureMax: *u.Max[i], TemperatureMin: *u.Min[i]}
		if len(u.Sunrise) == n {
			day.Sunrise = u.Sunrise[i]
		}
		if len(u.Sunset) == n {
			day.Sunset = u.Sunset[i]
		}
		if len(u.Probability) == n {
			day.PrecipitationProbability = u.Probability[i]
		}
		d.Daily = append(d.Daily, day)
	}
	encoded, _ := json.Marshal(d)
	validated, err := normalizeComponentData("weather.forecast", encoded)
	if err != nil {
		return d, err
	}
	return validated.(WeatherData), nil
}

func (a *App) runComponentIntegration(ctx context.Context, job integrationTrafficJob) {
	ctx, done := a.beginNetworkOperation(ctx)
	defer done()
	var secret integrationSecretInput
	var failure *IntegrationFailure
	var data any
	if job.source.credentialCipher != "" {
		raw, err := a.decryptIntegrationSecret(job.source.ID, job.source.credentialCipher)
		if err != nil || json.Unmarshal([]byte(raw), &secret) != nil {
			failure = componentIntegrationFailure("credential_unavailable")
		}
	}
	if failure == nil && !integrationHasRequiredSecret(job.source.Kind, job.source.Connection, &secret) {
		failure = componentIntegrationFailure("credential_unavailable")
	}
	if failure == nil {
		private := job.source.Connection["allowPrivateNetwork"] == "true"
		client := a.newOutboundIntegrationHTTPClient(private)
		defer client.CloseIdleConnections()
		rawURL := secret.URL
		if job.source.Kind == "weather-open-meteo" {
			rawURL = weatherIntegrationURL(job.source, secret)
		}
		body, failed := fetchIntegrationBody(ctx, client, rawURL, private, secret.BearerToken)
		failure = failed
		if failure == nil {
			var err error
			switch job.source.Kind {
			case "weather-open-meteo":
				data, err = normalizeOpenMeteo(body, job.source)
			case "calendar-ics":
				var opts CalendarParseOptions
				opts, err = integrationCalendarOptions(job.source.Connection, time.Now())
				if err == nil {
					data, err = parseCalendarICS(body, opts)
				}
			case "external-json":
				data, err = normalizeComponentData(job.source.SchemaID, body)
			default:
				err = invalid("unsupported source kind")
			}
			if err != nil {
				failure = componentDataFailure(job.source.Kind, err)
			}
		}
	}
	if ctx.Err() != nil {
		return
	}
	_ = a.persistComponentIntegration(ctx, job, data, failure)
}

func componentDataFailure(kind string, err error) *IntegrationFailure {
	failure := componentIntegrationFailure("source_invalid_data")
	if kind == "calendar-ics" {
		failure.Code = "calendar_invalid_data"
		failure.Message = "The calendar file could not be parsed. Check its format, dates and timezone."
		text := strings.ToLower(err.Error())
		if strings.Contains(text, "limit") || strings.Contains(text, "exceeds") || strings.Contains(text, "too large") || strings.Contains(text, "more than") {
			failure.Code = "calendar_limit_exceeded"
			failure.Message = "The calendar exceeds its event, time-window or recurrence-work limit."
		} else if strings.Contains(text, "unsupported") || strings.Contains(text, "not supported") || strings.Contains(text, "supports") {
			failure.Code = "calendar_unsupported_feature"
			failure.Message = "The calendar uses an unsupported component, timezone or recurrence feature. Use a normalized calendar snapshot or a compatible ICS export."
		}
	}
	return failure
}
func (a *App) persistComponentIntegration(ctx context.Context, job integrationTrafficJob, data any, failure *IntegrationFailure) error {
	// Complete encoding and schema/size checks before opening a write transaction.
	// Parser failures and oversized expanded calendars are recorded without losing
	// the last successful snapshot, and no upstream response text is exposed.
	var encoded []byte
	if failure == nil {
		var err error
		encoded, err = json.Marshal(data)
		if err != nil {
			failure = componentDataFailure(job.source.Kind, err)
		} else if len(encoded) > 1<<20 {
			failure = componentIntegrationFailure("source_snapshot_too_large")
			failure.Message = "The normalized source snapshot exceeds the 1 MiB storage limit."
		} else if _, err = normalizeComponentData(job.source.SchemaID, encoded); err != nil {
			failure = componentDataFailure(job.source.Kind, err)
		}
	}
	return a.integrationTransaction(ctx, func(q Queryer) error {
		if err := a.checkNetworkOperation(ctx, q); err != nil {
			return err
		}
		source, err := a.loadIntegrationSource(ctx, q, job.source.ID)
		if err != nil {
			return err
		}
		if !source.Enabled || source.ConfigRevision != job.source.ConfigRevision {
			return nil
		}
		settings, user, err := a.integrationSourceAccount(ctx, q, source)
		if err != nil {
			var api *APIError
			if errors.As(err, &api) {
				return nil
			}
			return err
		}
		if settings.AuthEpoch != job.epoch || user.Version != job.userVersion {
			return nil
		}
		if failure != nil {
			encoded, _ := json.Marshal(failure)
			_, err = q.ExecContext(ctx, a.store.Query("UPDATE integration_sources SET last_error_json=? WHERE id=?"), string(encoded), source.ID)
			return err
		}
		revision, err := strconv.ParseInt(source.Revision, 10, 64)
		if err != nil || revision == math.MaxInt64 {
			return invalid("snapshot revision limit reached")
		}
		now := integrationStamp(time.Now().UTC().Truncate(time.Microsecond))
		_, err = q.ExecContext(ctx, a.store.Query(`INSERT INTO integration_snapshots(source_id,revision,source_sequence,data_json,source_updated_at,received_at) VALUES(?,?,NULL,?,NULL,?) ON CONFLICT(source_id) DO UPDATE SET revision=excluded.revision,data_json=excluded.data_json,source_updated_at=NULL,received_at=excluded.received_at`), source.ID, revision+1, string(encoded), now)
		if err != nil {
			return err
		}
		_, err = q.ExecContext(ctx, a.store.Query("UPDATE integration_sources SET last_success_at=?,last_error_json=NULL WHERE id=?"), now, source.ID)
		return err
	})
}
