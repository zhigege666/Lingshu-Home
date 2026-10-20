package home

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"math"
	"sort"
	"strings"
	"time"
	_ "time/tzdata"
)

// Calendar timestamps are Unix seconds. All-day dates retain their original
// calendar dates, with an exclusive end date, independently of browser timezone.
type CalendarData struct {
	Timezone    string          `json:"timezone"`
	WindowStart int64           `json:"windowStart"`
	WindowEnd   int64           `json:"windowEnd"`
	Events      []CalendarEvent `json:"events"`
}
type CalendarEvent struct {
	ID          string `json:"id"`
	Title       string `json:"title"`
	StartAt     int64  `json:"startAt"`
	EndAt       int64  `json:"endAt"`
	AllDay      bool   `json:"allDay"`
	StartDate   string `json:"startDate,omitempty"`
	EndDate     string `json:"endDate,omitempty"`
	Timezone    string `json:"timezone,omitempty"`
	Location    string `json:"location,omitempty"`
	Description string `json:"description,omitempty"`
	URL         string `json:"url,omitempty"`
	Status      string `json:"status,omitempty"`
}
type WeatherData struct {
	Timezone     string          `json:"timezone"`
	Latitude     float64         `json:"latitude"`
	Longitude    float64         `json:"longitude"`
	LocationName string          `json:"locationName,omitempty"`
	Current      *WeatherCurrent `json:"current,omitempty"`
	Daily        []WeatherDay    `json:"daily"`
}
type WeatherCurrent struct {
	Time                int64    `json:"time"`
	Temperature         float64  `json:"temperature"`
	ApparentTemperature *float64 `json:"apparentTemperature,omitempty"`
	WeatherCode         int      `json:"weatherCode"`
	Humidity            *float64 `json:"humidity,omitempty"`
	WindSpeed           *float64 `json:"windSpeed,omitempty"`
	IsDay               bool     `json:"isDay"`
}
type WeatherDay struct {
	Date                     string   `json:"date"`
	WeatherCode              int      `json:"weatherCode"`
	TemperatureMax           float64  `json:"temperatureMax"`
	TemperatureMin           float64  `json:"temperatureMin"`
	Sunrise                  *int64   `json:"sunrise,omitempty"`
	Sunset                   *int64   `json:"sunset,omitempty"`
	PrecipitationProbability *float64 `json:"precipitationProbability,omitempty"`
}
type MetricsData struct {
	Metrics []MetricItem `json:"metrics"`
}
type MetricItem struct {
	ID     string   `json:"id"`
	Label  string   `json:"label"`
	Value  *float64 `json:"value"`
	Unit   string   `json:"unit,omitempty"`
	Min    *float64 `json:"min,omitempty"`
	Max    *float64 `json:"max,omitempty"`
	Status string   `json:"status,omitempty"`
}
type StatusData struct {
	Items []StatusItem `json:"items"`
}
type StatusItem struct {
	ID        string   `json:"id"`
	Label     string   `json:"label"`
	Status    string   `json:"status"`
	Message   string   `json:"message,omitempty"`
	LatencyMs *float64 `json:"latencyMs,omitempty"`
	URL       string   `json:"url,omitempty"`
}

func integrationComponentSchema(schema string) bool {
	return oneOf(schema, "calendar.events", "weather.forecast", "metrics.summary", "status.collection")
}
func integrationStrictJSON(raw []byte, target any) error {
	if len(raw) == 0 || len(raw) > 1<<20 || bytes.Equal(bytes.TrimSpace(raw), []byte("null")) {
		return invalid("component data must be an object of at most 1 MiB")
	}
	d := json.NewDecoder(bytes.NewReader(raw))
	d.DisallowUnknownFields()
	if err := d.Decode(target); err != nil {
		return invalid("component data has invalid values or unknown fields")
	}
	var extra any
	if err := d.Decode(&extra); !errors.Is(err, io.EOF) {
		return invalid("component data must contain exactly one JSON object")
	}
	return nil
}
func integrationTimezone(zone string) (*time.Location, error) {
	if len(zone) == 0 || len(zone) > 80 || zone == "Local" {
		return nil, invalid("an explicit IANA timezone is required")
	}
	l, err := time.LoadLocation(zone)
	if err != nil {
		return nil, invalid("unknown IANA timezone")
	}
	return l, nil
}
func integrationFinite(v float64) bool { return !math.IsNaN(v) && !math.IsInf(v, 0) }
func integrationOptionalNumber(v *float64, low, high float64) bool {
	return v == nil || (integrationFinite(*v) && *v >= low && *v <= high)
}
func integrationDataString(s string, max int, mandatory bool) bool {
	return len(s) <= max && !strings.ContainsAny(s, "\x00\r") && (!mandatory || strings.TrimSpace(s) != "")
}
func integrationDataURL(raw string) bool {
	if raw == "" {
		return true
	}
	_, err := canonicalURL(raw)
	return err == nil
}
func normalizeComponentData(schema string, raw []byte) (any, error) {
	switch schema {
	case "calendar.events":
		var d CalendarData
		if err := integrationStrictJSON(raw, &d); err != nil {
			return nil, err
		}
		if err := integrationRequiredDataFields(raw, []string{"timezone", "windowStart", "windowEnd", "events"}); err != nil {
			return nil, err
		}
		if err := integrationRequiredArrayFields(raw, "events", []string{"id", "title", "startAt", "endAt", "allDay"}); err != nil {
			return nil, err
		}
		zone, zoneErr := integrationTimezone(d.Timezone)
		if zoneErr != nil {
			return nil, zoneErr
		}
		if d.Events == nil || len(d.Events) > 500 || d.WindowStart <= 0 || d.WindowEnd <= d.WindowStart || d.WindowEnd > 253402300799 || time.Unix(d.WindowEnd, 0).After(time.Unix(d.WindowStart, 0).In(zone).AddDate(0, 0, 90)) {
			return nil, invalid("calendar requires a bounded window and at most 500 events")
		}
		seen := map[string]bool{}
		for i := range d.Events {
			e := &d.Events[i]
			if !integrationDataString(e.ID, 256, true) || seen[e.ID] || !integrationDataString(e.Title, 300, true) || e.StartAt <= 0 || e.EndAt > 253402300799 || e.EndAt < e.StartAt || e.EndAt-e.StartAt > 366*86400 {
				return nil, invalid("calendar event ID, title or time is invalid")
			}
			seen[e.ID] = true
			if (e.EndAt < d.WindowStart || (e.EndAt == d.WindowStart && e.StartAt != e.EndAt)) || e.StartAt >= d.WindowEnd {
				return nil, invalid("calendar event is outside its declared window")
			}
			eventZone := zone
			if e.Timezone != "" {
				var err error
				eventZone, err = integrationTimezone(e.Timezone)
				if err != nil {
					return nil, err
				}
			}
			if e.Status == "" {
				e.Status = "confirmed"
			}
			if !oneOf(e.Status, "confirmed", "tentative", "cancelled") || !integrationDataString(e.Location, 500, false) || !integrationDataString(e.Description, 4000, false) || !integrationDataURL(e.URL) {
				return nil, invalid("calendar event metadata is invalid")
			}
			if e.AllDay {
				a, errA := time.Parse("2006-01-02", e.StartDate)
				b, errB := time.Parse("2006-01-02", e.EndDate)
				if errA != nil || errB != nil || !b.After(a) || b.Sub(a) > 366*24*time.Hour {
					return nil, invalid("all-day events require a bounded exclusive date range")
				}
				start, end := time.Unix(e.StartAt, 0).In(eventZone), time.Unix(e.EndAt, 0).In(eventZone)
				if start.Format("2006-01-02") != e.StartDate || end.Format("2006-01-02") != e.EndDate || start.Hour() != 0 || start.Minute() != 0 || start.Second() != 0 || end.Hour() != 0 || end.Minute() != 0 || end.Second() != 0 {
					return nil, invalid("all-day dates must match their timezone and midnight timestamps")
				}
			} else if e.StartDate != "" || e.EndDate != "" {
				return nil, invalid("timed events must not contain all-day dates")
			}
		}
		sort.SliceStable(d.Events, func(i, j int) bool {
			if d.Events[i].StartAt != d.Events[j].StartAt {
				return d.Events[i].StartAt < d.Events[j].StartAt
			}
			return d.Events[i].ID < d.Events[j].ID
		})
		return d, nil
	case "weather.forecast":
		var d WeatherData
		if err := integrationStrictJSON(raw, &d); err != nil {
			return nil, err
		}
		if err := integrationRequiredDataFields(raw, []string{"timezone", "latitude", "longitude", "daily"}); err != nil {
			return nil, err
		}
		if err := integrationRequiredArrayFields(raw, "daily", []string{"date", "weatherCode", "temperatureMax", "temperatureMin"}); err != nil {
			return nil, err
		}
		var wire map[string]json.RawMessage
		_ = json.Unmarshal(raw, &wire)
		if c, exists := wire["current"]; exists {
			if err := integrationRequiredDataFields(c, []string{"time", "temperature", "weatherCode", "isDay"}); err != nil {
				return nil, err
			}
		}
		if _, err := integrationTimezone(d.Timezone); err != nil {
			return nil, err
		}
		if !integrationFinite(d.Latitude) || d.Latitude < -90 || d.Latitude > 90 || !integrationFinite(d.Longitude) || d.Longitude < -180 || d.Longitude > 180 || !integrationDataString(d.LocationName, 120, false) || d.Daily == nil || len(d.Daily) > 7 {
			return nil, invalid("weather location or forecast length is invalid")
		}
		if c := d.Current; c != nil {
			if c.Time <= 0 || !integrationFinite(c.Temperature) || c.Temperature < -150 || c.Temperature > 100 || !integrationWeatherCode(c.WeatherCode) || !integrationOptionalNumber(c.ApparentTemperature, -200, 150) || !integrationOptionalNumber(c.Humidity, 0, 100) || !integrationOptionalNumber(c.WindSpeed, 0, 1000) {
				return nil, invalid("current weather values are invalid")
			}
		}
		seen := map[string]bool{}
		for _, day := range d.Daily {
			if _, err := time.Parse("2006-01-02", day.Date); err != nil || seen[day.Date] {
				return nil, invalid("weather days must be unique ISO dates")
			}
			seen[day.Date] = true
			if !integrationWeatherCode(day.WeatherCode) || !integrationFinite(day.TemperatureMin) || !integrationFinite(day.TemperatureMax) || day.TemperatureMin < -150 || day.TemperatureMax > 100 || day.TemperatureMax < day.TemperatureMin || !integrationOptionalNumber(day.PrecipitationProbability, 0, 100) || (day.Sunrise != nil && *day.Sunrise <= 0) || (day.Sunset != nil && *day.Sunset <= 0) {
				return nil, invalid("weather forecast values are invalid")
			}
		}
		sort.Slice(d.Daily, func(i, j int) bool { return d.Daily[i].Date < d.Daily[j].Date })
		return d, nil
	case "metrics.summary":
		var d MetricsData
		if err := integrationStrictJSON(raw, &d); err != nil {
			return nil, err
		}
		if err := integrationRequiredArrayFields(raw, "metrics", []string{"id", "label", "value"}, "value"); err != nil {
			return nil, err
		}
		if d.Metrics == nil || len(d.Metrics) > 32 {
			return nil, invalid("metrics must be an array of at most 32 entries")
		}
		seen := map[string]bool{}
		for i := range d.Metrics {
			m := &d.Metrics[i]
			if !integrationExternalID.MatchString(m.ID) || seen[m.ID] || !integrationDataString(m.Label, 100, true) || !integrationDataString(m.Unit, 30, false) || !integrationOptionalNumber(m.Value, -1e18, 1e18) || !integrationOptionalNumber(m.Min, -1e18, 1e18) || !integrationOptionalNumber(m.Max, -1e18, 1e18) || (m.Min != nil && m.Max != nil && *m.Max <= *m.Min) {
				return nil, invalid("metric identifier or value is invalid")
			}
			seen[m.ID] = true
			if m.Value == nil {
				m.Status = "unknown"
			}
			if m.Status != "" && !oneOf(m.Status, "ok", "warning", "critical", "unknown") {
				return nil, invalid("unknown metric status")
			}
		}
		return d, nil
	case "status.collection":
		var d StatusData
		if err := integrationStrictJSON(raw, &d); err != nil {
			return nil, err
		}
		if err := integrationRequiredArrayFields(raw, "items", []string{"id", "label", "status"}); err != nil {
			return nil, err
		}
		if d.Items == nil || len(d.Items) > 64 {
			return nil, invalid("status items must be an array of at most 64 entries")
		}
		seen := map[string]bool{}
		for _, item := range d.Items {
			if !integrationExternalID.MatchString(item.ID) || seen[item.ID] || !integrationDataString(item.Label, 100, true) || !oneOf(item.Status, "up", "degraded", "down", "unknown") || !integrationDataString(item.Message, 500, false) || !integrationOptionalNumber(item.LatencyMs, 0, 86400000) || !integrationDataURL(item.URL) {
				return nil, invalid("status item is invalid")
			}
			seen[item.ID] = true
		}
		return d, nil
	}
	return nil, invalid("unsupported component schema")
}

func integrationWeatherCode(code int) bool {
	switch code {
	case 0, 1, 2, 3, 45, 48, 51, 53, 55, 56, 57, 61, 63, 65, 66, 67, 71, 73, 75, 77, 80, 81, 82, 85, 86, 95, 96, 99:
		return true
	}
	return false
}

func integrationRequiredDataFields(raw []byte, required []string, nullable ...string) error {
	var fields map[string]json.RawMessage
	if json.Unmarshal(raw, &fields) != nil || fields == nil {
		return invalid("component data must be an object")
	}
	for _, name := range required {
		value, exists := fields[name]
		if !exists {
			return invalid("component data is missing required field: " + name)
		}
		if bytes.Equal(bytes.TrimSpace(value), []byte("null")) {
			allowed := false
			for _, key := range nullable {
				if key == name {
					allowed = true
				}
			}
			if !allowed {
				return invalid("component field must not be null: " + name)
			}
		}
	}
	return nil
}
func integrationRequiredArrayFields(raw []byte, key string, required []string, nullable ...string) error {
	var outer map[string]json.RawMessage
	_ = json.Unmarshal(raw, &outer)
	var rows []json.RawMessage
	if json.Unmarshal(outer[key], &rows) != nil {
		return invalid("component data array is invalid")
	}
	for _, row := range rows {
		if err := integrationRequiredDataFields(row, required, nullable...); err != nil {
			return err
		}
	}
	return nil
}
