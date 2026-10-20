package home

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	ical "github.com/emersion/go-ical"
	"github.com/teambition/rrule-go"
)

// CalendarParseOptions always uses an explicit display/floating-time timezone.
// WindowEnd is exclusive. The parser neither fetches URLs nor stores the ICS.
type CalendarParseOptions struct {
	WindowStart      time.Time
	WindowEnd        time.Time
	CalendarTimezone string
}

const (
	calendarMaxBytes      = 1 << 20
	calendarMaxEvents     = 500
	calendarMaxComponents = 2000
	calendarMaxWork       = 100000
	calendarMaxDates      = 10000
	calendarMaxSpan       = 366 * 24 * time.Hour
)

func integrationCalendarOptions(connection map[string]string, now time.Time) (CalendarParseOptions, error) {
	zone := connection["timezone"]
	loc, err := integrationTimezone(zone)
	if err != nil {
		return CalendarParseOptions{}, err
	}
	days := func(key string, fallback, low, high int) (int, error) {
		value := connection[key]
		if value == "" {
			return fallback, nil
		}
		n, err := strconv.Atoi(value)
		if err != nil || n < low || n > high || strconv.Itoa(n) != value {
			return 0, invalid("invalid calendar window: " + key)
		}
		return n, nil
	}
	past, err := days("pastDays", 1, 0, 30)
	if err != nil {
		return CalendarParseOptions{}, err
	}
	future, err := days("futureDays", 30, 1, 90)
	if err != nil || past+future > 90 {
		return CalendarParseOptions{}, invalid("calendar window must be between 1 and 90 days")
	}
	local := now.In(loc)
	day := time.Date(local.Year(), local.Month(), local.Day(), 0, 0, 0, 0, time.UTC)
	start, ok := calendarWallTime(day.AddDate(0, 0, -past), loc)
	if !ok {
		return CalendarParseOptions{}, invalid("calendar window begins at a nonexistent local time")
	}
	end, ok := calendarWallTime(day.AddDate(0, 0, future), loc)
	if !ok {
		return CalendarParseOptions{}, invalid("calendar window ends at a nonexistent local time")
	}
	return CalendarParseOptions{WindowStart: start, WindowEnd: end, CalendarTimezone: zone}, nil
}

type calendarInstant struct {
	time     time.Time
	wall     time.Time // Local date/clock components represented in UTC, never an instant.
	allDay   bool
	floating bool
	zone     string
}

func (v calendarInstant) key() string {
	if v.allDay {
		return "date:" + v.wall.Format("20060102")
	}
	return "time:" + strconv.FormatInt(v.time.Unix(), 10)
}

type calendarLength struct {
	days  int           // Nominal calendar days, from DATE or DURATION.
	exact time.Duration // Exact duration, from DTEND or the time part of DURATION.
}

type calendarRecord struct {
	uid       string
	start     calendarInstant
	hasStart  bool
	length    calendarLength
	rid       *calendarInstant
	rule      *rrule.ROption
	rdates    []calendarInstant
	exdates   map[string]bool
	event     CalendarEvent
	sequence  int
	stamp     time.Time
	component *ical.Component
}

type calendarBudget struct {
	work  int
	dates int
}

func (b *calendarBudget) spend(n int) error {
	b.work += n
	if b.work > calendarMaxWork {
		return invalid("calendar recurrence expansion exceeds the work limit")
	}
	return nil
}

// parseCalendarICS supports a deliberately bounded RFC 5545 subset: VEVENT,
// UTC/IANA/floating times, DATE, common daily/weekly/monthly/yearly rules, and
// single-instance exceptions. It rejects unsupported recurrence semantics.
// go-ical handles content-line syntax; rrule-go parses/validates RRULE. We do
// not call its unbounded iterator: a rule with no matching dates can otherwise
// scan to year 9999 before returning even when an UNTIL value was supplied.
func parseCalendarICS(raw []byte, opts CalendarParseOptions) (CalendarData, error) {
	result := CalendarData{Timezone: opts.CalendarTimezone, WindowStart: opts.WindowStart.Unix(), WindowEnd: opts.WindowEnd.Unix(), Events: []CalendarEvent{}}
	loc, err := integrationTimezone(opts.CalendarTimezone)
	if err != nil {
		return result, err
	}
	if opts.WindowStart.Unix() <= 0 || !opts.WindowEnd.After(opts.WindowStart) || opts.WindowEnd.After(opts.WindowStart.In(loc).AddDate(0, 0, 90)) {
		return result, invalid("calendar requires an exclusive window of at most 90 calendar days")
	}
	if err = calendarCheckInput(raw); err != nil {
		return result, err
	}
	cal, err := calendarDecode(raw)
	if err != nil {
		return result, err
	}
	version, err := calendarSingle(cal.Props, "VERSION", true)
	if err != nil || version.Value != "2.0" {
		return result, invalid("calendar VERSION must be 2.0")
	}
	if method, err := calendarSingle(cal.Props, "METHOD", false); err != nil || (method != nil && !strings.EqualFold(method.Value, "PUBLISH")) {
		return result, invalid("scheduling METHOD messages are not supported; use a calendar snapshot")
	}
	masters := map[string]*calendarRecord{}
	overrides := map[string]map[string]*calendarRecord{}
	budget := &calendarBudget{}
	for _, component := range cal.Children {
		if component.Name == "VTIMEZONE" {
			// An IANA identifier is resolved by the bundled timezone database.
			// Custom definitions cannot safely be interpreted as a fixed offset.
			if err := calendarCheckTimezone(component, opts, budget); err != nil {
				return result, err
			}
			continue
		}
		if component.Name != "VEVENT" {
			return result, invalid("only VEVENT calendars are supported")
		}
		r, err := calendarParseRecord(component, loc, budget)
		if err != nil {
			return result, err
		}
		if r.rid == nil {
			old := masters[r.uid]
			if newer, err := calendarNewer(old, r); err != nil {
				return result, err
			} else if newer {
				masters[r.uid] = r
			}
		} else {
			if overrides[r.uid] == nil {
				overrides[r.uid] = map[string]*calendarRecord{}
			}
			key := r.rid.key()
			if newer, err := calendarNewer(overrides[r.uid][key], r); err != nil {
				return result, err
			} else if newer {
				overrides[r.uid][key] = r
			}
		}
	}
	for uid := range overrides {
		if masters[uid] == nil {
			return result, invalid("calendar recurrence exception has no master event")
		}
	}
	// Sorted source identities keep the work limit and failures deterministic.
	uids := make([]string, 0, len(masters))
	for uid := range masters {
		uids = append(uids, uid)
	}
	sort.Strings(uids)
	for _, uid := range uids {
		master := masters[uid]
		if master.event.Status == "cancelled" {
			continue
		}
		exceptions := overrides[uid]
		lower := opts.WindowStart.Add(-calendarMaxSpan)
		upper := opts.WindowEnd
		for _, exception := range exceptions {
			if exception.rid.allDay != master.start.allDay || exception.rid.floating != master.start.floating || (exception.hasStart && exception.start.allDay != master.start.allDay) {
				return result, invalid("calendar recurrence exception changes DATE/DATE-TIME type")
			}
			if exception.rid.time.Before(lower) {
				lower = exception.rid.time
			}
			if !exception.rid.time.Before(upper) {
				upper = exception.rid.time.Add(time.Second)
			}
		}
		starts, err := calendarExpand(master, lower, upper, budget)
		if err != nil {
			return result, err
		}
		for key := range exceptions {
			if _, ok := starts[key]; !ok {
				return result, invalid("RECURRENCE-ID does not identify an occurrence of its master")
			}
		}
		for key, start := range starts {
			record := master
			if exception := exceptions[key]; exception != nil {
				record, start = exception, exception.start
			} else if master.exdates[key] {
				continue
			}
			if record.event.Status == "cancelled" {
				continue
			}
			event, err := calendarOccurrence(record, start, uid, key)
			if err != nil {
				return result, err
			}
			if event.StartAt >= result.WindowEnd || (event.EndAt <= result.WindowStart && event.EndAt != event.StartAt) || (event.EndAt == event.StartAt && event.StartAt < result.WindowStart) {
				continue
			}
			result.Events = append(result.Events, event)
			if len(result.Events) > calendarMaxEvents {
				return CalendarData{}, invalid("calendar window contains more than 500 events")
			}
		}
	}
	sort.Slice(result.Events, func(i, j int) bool {
		if result.Events[i].StartAt != result.Events[j].StartAt {
			return result.Events[i].StartAt < result.Events[j].StartAt
		}
		return result.Events[i].ID < result.Events[j].ID
	})
	return result, nil
}

func calendarDecode(raw []byte) (cal *ical.Calendar, err error) {
	// The upstream content-line decoder contains panic paths for malformed
	// parameter input. Reject that input without unwinding a background worker.
	defer func() {
		if recover() != nil {
			cal, err = nil, invalid("invalid iCalendar content")
		}
	}()
	decoder := ical.NewDecoder(bytes.NewReader(raw))
	cal, err = decoder.Decode()
	if err != nil {
		return nil, invalid("invalid iCalendar content")
	}
	if _, err = decoder.Decode(); !errors.Is(err, io.EOF) {
		return nil, invalid("calendar input must contain exactly one VCALENDAR")
	}
	return cal, nil
}

// Bound recursion before invoking the general-purpose decoder. Unfold first,
// including folded BEGIN/END lines, so line folding cannot bypass the limit.
func calendarCheckInput(raw []byte) error {
	if len(raw) == 0 || len(raw) > calendarMaxBytes || !utf8.Valid(raw) || bytes.IndexByte(raw, 0) >= 0 {
		return invalid("calendar must be valid UTF-8 of at most 1 MiB")
	}
	text := strings.ReplaceAll(string(raw), "\r\n", "\n")
	if strings.ContainsRune(text, '\r') {
		return invalid("calendar has invalid line endings")
	}
	lines := make([]string, 0)
	for _, line := range strings.Split(text, "\n") {
		if len(line) > 0 && (line[0] == ' ' || line[0] == '\t') {
			if len(lines) == 0 {
				return invalid("calendar has an invalid folded line")
			}
			lines[len(lines)-1] += line[1:]
		} else {
			lines = append(lines, line)
		}
		if len(lines) > 20000 || (len(lines) > 0 && len(lines[len(lines)-1]) > 16384) {
			return invalid("calendar exceeds the content-line limit")
		}
	}
	stack := []string{}
	components, events := 0, 0
	for _, line := range lines {
		upper := strings.ToUpper(line)
		if strings.HasPrefix(upper, "BEGIN:") {
			name := strings.TrimPrefix(upper, "BEGIN:")
			stack = append(stack, name)
			components++
			if name == "VEVENT" {
				events++
			}
			if len(stack) > 4 || components > 6000 || events > calendarMaxComponents {
				return invalid("calendar exceeds the component/depth limit")
			}
		} else if strings.HasPrefix(upper, "END:") {
			if len(stack) == 0 || stack[len(stack)-1] != strings.TrimPrefix(upper, "END:") {
				return invalid("calendar has mismatched component boundaries")
			}
			stack = stack[:len(stack)-1]
		} else if strings.HasPrefix(upper, "BEGIN;") || strings.HasPrefix(upper, "END;") {
			return invalid("calendar component boundaries cannot have parameters")
		}
	}
	if len(stack) != 0 {
		return invalid("calendar has an unterminated component")
	}
	return nil
}

func calendarSingle(props ical.Props, name string, required bool) (*ical.Prop, error) {
	values := props[name]
	if len(values) > 1 || (required && len(values) == 0) {
		return nil, invalid("calendar property must occur once: " + name)
	}
	if len(values) == 0 {
		return nil, nil
	}
	return &values[0], nil
}

func calendarNewer(old, next *calendarRecord) (bool, error) {
	if old == nil {
		return true, nil
	}
	if next.sequence != old.sequence {
		return next.sequence > old.sequence, nil
	}
	if !next.stamp.Equal(old.stamp) {
		return next.stamp.After(old.stamp), nil
	}
	return false, invalid("calendar has ambiguous duplicate UID/RECURRENCE-ID revisions")
}

func calendarParseRecord(c *ical.Component, loc *time.Location, budget *calendarBudget) (*calendarRecord, error) {
	r := &calendarRecord{component: c, exdates: map[string]bool{}, event: CalendarEvent{Status: "confirmed"}}
	for _, child := range c.Children {
		if child.Name != "VALARM" || len(child.Children) != 0 {
			return nil, invalid("unsupported nested calendar component")
		}
	}
	for _, key := range []string{"UID", "DTSTART", "DTEND", "DURATION", "RECURRENCE-ID", "RRULE", "SUMMARY", "DESCRIPTION", "LOCATION", "URL", "STATUS", "SEQUENCE", "DTSTAMP"} {
		if _, err := calendarSingle(c.Props, key, false); err != nil {
			return nil, err
		}
	}
	if len(c.Props["EXRULE"]) != 0 {
		return nil, invalid("EXRULE is not supported; use EXDATE")
	}
	uid, err := calendarSingle(c.Props, "UID", true)
	if err != nil {
		return nil, err
	}
	r.uid, err = uid.Text()
	if err != nil || strings.TrimSpace(r.uid) == "" || len(r.uid) > 1024 || strings.ContainsAny(r.uid, "\x00\r\n") {
		return nil, invalid("calendar event UID is invalid")
	}
	if prop := c.Props.Get("STATUS"); prop != nil {
		r.event.Status = strings.ToLower(prop.Value)
		if !oneOf(r.event.Status, "confirmed", "tentative", "cancelled") {
			return nil, invalid("calendar event STATUS is invalid")
		}
	}
	if prop := c.Props.Get("SEQUENCE"); prop != nil {
		r.sequence, err = strconv.Atoi(prop.Value)
		if err != nil || r.sequence < 0 || r.sequence > 2147483647 {
			return nil, invalid("calendar event SEQUENCE is invalid")
		}
	}
	if prop := c.Props.Get("DTSTAMP"); prop != nil {
		if len(prop.Params) != 0 || !strings.HasSuffix(prop.Value, "Z") {
			return nil, invalid("calendar DTSTAMP must be a UTC date-time")
		}
		r.stamp, err = time.Parse("20060102T150405Z", prop.Value)
		if err != nil {
			return nil, invalid("calendar DTSTAMP is invalid")
		}
	}
	if prop := c.Props.Get("RECURRENCE-ID"); prop != nil {
		if prop.Params.Get("RANGE") != "" {
			return nil, invalid("RECURRENCE-ID RANGE is not supported")
		}
		value, err := calendarParseTime(prop, loc)
		if err != nil {
			return nil, err
		}
		r.rid = &value
	}
	if prop := c.Props.Get("DTSTART"); prop != nil {
		r.start, err = calendarParseTime(prop, loc)
		if err != nil {
			return nil, err
		}
		r.hasStart = true
	} else if r.event.Status != "cancelled" {
		return nil, invalid("calendar event DTSTART is required")
	}
	if r.rid != nil && (c.Props.Get("RRULE") != nil || len(c.Props["RDATE"]) != 0 || len(c.Props["EXDATE"]) != 0) {
		return nil, invalid("recurrence exceptions cannot define another recurrence set")
	}
	if r.event.Status == "cancelled" && !r.hasStart {
		return r, nil
	}
	r.length, err = calendarEventLength(c.Props, r.start, loc)
	if err != nil {
		return nil, err
	}
	for key, target := range map[string]*string{"SUMMARY": &r.event.Title, "LOCATION": &r.event.Location, "DESCRIPTION": &r.event.Description} {
		if prop := c.Props.Get(key); prop != nil {
			value, err := prop.Text()
			if err != nil {
				return nil, invalid("invalid calendar text property: " + key)
			}
			limit := 4000
			if key == "SUMMARY" {
				limit = 300
			} else if key == "LOCATION" {
				limit = 500
			}
			*target = calendarPlainText(value, limit)
		}
	}
	if r.event.Title == "" {
		r.event.Title = "Untitled event"
	}
	if prop := c.Props.Get("URL"); prop != nil && integrationDataURL(prop.Value) {
		r.event.URL = prop.Value
	}
	if prop := c.Props.Get("RRULE"); prop != nil {
		r.rule, err = calendarParseRule(prop, r.start)
		if err != nil {
			return nil, err
		}
	}
	for _, name := range []string{"RDATE", "EXDATE"} {
		for _, prop := range c.Props[name] {
			values := strings.Split(prop.Value, ",")
			budget.dates += len(values)
			if budget.dates > calendarMaxDates {
				return nil, invalid("calendar exceeds the explicit recurrence-date limit")
			}
			for _, raw := range values {
				copy := prop
				copy.Value = raw
				value, err := calendarParseTime(&copy, loc)
				if err != nil || value.allDay != r.start.allDay || value.floating != r.start.floating {
					return nil, invalid("RDATE/EXDATE must have the same DATE/DATE-TIME type as DTSTART")
				}
				if name == "RDATE" {
					// Explicit UTC dates still belong to the master's recurrence
					// timezone, including nominal P1D durations across DST.
					if !value.allDay {
						masterLoc, _ := time.LoadLocation(r.start.zone)
						local := value.time.In(masterLoc)
						value.time, value.zone = local, r.start.zone
						value.wall = time.Date(local.Year(), local.Month(), local.Day(), local.Hour(), local.Minute(), local.Second(), 0, time.UTC)
					}
					r.rdates = append(r.rdates, value)
				} else {
					r.exdates[value.key()] = true
				}
			}
		}
	}
	return r, nil
}

func calendarPlainText(value string, limit int) string {
	// The API transports text only. It never interprets SUMMARY or X-ALT-DESC as
	// HTML, and the component renderer must continue to use React text nodes.
	value = strings.ReplaceAll(strings.ReplaceAll(value, "\r\n", "\n"), "\r", "\n")
	var out strings.Builder
	for _, r := range strings.TrimSpace(value) {
		if unicode.IsControl(r) && r != '\n' && r != '\t' {
			continue
		}
		if out.Len()+utf8.RuneLen(r) > limit {
			break
		}
		out.WriteRune(r)
	}
	return strings.TrimSpace(out.String())
}

func calendarParseTime(prop *ical.Prop, calendarLoc *time.Location) (calendarInstant, error) {
	var result calendarInstant
	for name, values := range prop.Params {
		if len(values) != 1 || !oneOf(name, "VALUE", "TZID") {
			return result, invalid("unsupported calendar date-time parameter: " + name)
		}
	}
	kind := strings.ToUpper(prop.Params.Get("VALUE"))
	zone := prop.Params.Get("TZID")
	loc := calendarLoc
	format := "20060102T150405"
	result.floating = zone == ""
	if kind == "DATE" {
		if zone != "" {
			return result, invalid("DATE values cannot contain TZID")
		}
		format, result.allDay, result.floating = "20060102", true, false
	} else if kind != "" && kind != "DATE-TIME" {
		return result, invalid("only DATE and DATE-TIME calendar values are supported")
	} else if strings.HasSuffix(prop.Value, "Z") {
		if zone != "" {
			return result, invalid("UTC date-times cannot contain TZID")
		}
		format, loc, result.floating = "20060102T150405Z", time.UTC, false
	} else if zone != "" {
		var err error
		loc, err = integrationTimezone(zone)
		if err != nil {
			return result, invalid("unsupported calendar TZID; use an IANA timezone")
		}
	}
	wall, err := time.Parse(format, prop.Value)
	if err != nil || wall.Format(format) != prop.Value {
		return result, invalid("calendar date-time is invalid or uses an unsupported format")
	}
	instant, ok := calendarWallTime(wall, loc)
	if !ok {
		return result, invalid("calendar date-time is nonexistent in its timezone")
	}
	result.wall, result.time, result.zone = wall, instant, loc.String()
	return result, nil
}

// Resolve a wall clock without Go's normalization of missing DST times. For a
// repeated clock time, RFC 5545 selects the first occurrence (earlier instant).
func calendarWallTime(wall time.Time, loc *time.Location) (time.Time, bool) {
	if loc == time.UTC {
		return wall, true
	}
	tentative := time.Date(wall.Year(), wall.Month(), wall.Day(), wall.Hour(), wall.Minute(), wall.Second(), 0, loc)
	var first time.Time
	for _, shift := range []time.Duration{-48 * time.Hour, 0, 48 * time.Hour} {
		_, offset := tentative.Add(shift).Zone()
		candidate := time.Unix(wall.Unix()-int64(offset), 0).In(loc)
		if candidate.Year() == wall.Year() && candidate.Month() == wall.Month() && candidate.Day() == wall.Day() && candidate.Hour() == wall.Hour() && candidate.Minute() == wall.Minute() && candidate.Second() == wall.Second() && (first.IsZero() || candidate.Before(first)) {
			first = candidate
		}
	}
	return first, !first.IsZero()
}

var calendarDurationPattern = regexp.MustCompile(`^P(?:(\d+)W|(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?)$`)

func calendarEventLength(props ical.Props, start calendarInstant, loc *time.Location) (calendarLength, error) {
	var length calendarLength
	end, duration := props.Get("DTEND"), props.Get("DURATION")
	if end != nil && duration != nil {
		return length, invalid("calendar event cannot contain both DTEND and DURATION")
	}
	if end != nil {
		value, err := calendarParseTime(end, loc)
		if err != nil || value.allDay != start.allDay || !value.time.After(start.time) || value.time.Sub(start.time) > calendarMaxSpan {
			return length, invalid("calendar DTEND must follow DTSTART with the same value type, within 366 days")
		}
		if start.allDay {
			length.days = int(value.wall.Sub(start.wall) / (24 * time.Hour))
		} else {
			length.exact = value.time.Sub(start.time)
		}
	} else if duration != nil {
		match := calendarDurationPattern.FindStringSubmatch(duration.Value)
		if match == nil || duration.Value == "P" || duration.Value == "PT" || strings.HasSuffix(duration.Value, "T") || len(duration.Params) != 0 {
			return length, invalid("calendar DURATION must be a positive week/day/time duration")
		}
		parts := make([]int, 5)
		for i := range parts {
			if match[i+1] != "" {
				value, err := strconv.Atoi(match[i+1])
				if err != nil || value > 31622400 {
					return length, invalid("calendar DURATION is too large")
				}
				parts[i] = value
			}
		}
		length.days = parts[0]*7 + parts[1]
		seconds := int64(parts[2])*3600 + int64(parts[3])*60 + int64(parts[4])
		if length.days > 366 || seconds > 366*86400 || int64(length.days)*86400+seconds > 366*86400 || (start.allDay && seconds != 0) || (length.days == 0 && seconds == 0) {
			return length, invalid("calendar DURATION must be positive and at most 366 days")
		}
		length.exact = time.Duration(seconds) * time.Second
	} else if start.allDay {
		length.days = 1
	}
	return length, nil
}

func calendarOccurrence(record *calendarRecord, start calendarInstant, uid, originalKey string) (CalendarEvent, error) {
	event := record.event
	end := start.time
	if record.length.days != 0 {
		loc, _ := time.LoadLocation(start.zone)
		var ok bool
		end, ok = calendarWallTime(start.wall.AddDate(0, 0, record.length.days), loc)
		if !ok {
			return event, invalid("calendar event end falls in a nonexistent local time")
		}
	}
	end = end.Add(record.length.exact)
	if end.Before(start.time) || end.Sub(start.time) > calendarMaxSpan {
		return event, invalid("calendar event duration exceeds 366 days")
	}
	digest := sha256.Sum256([]byte(uid + "\x00" + originalKey))
	event.ID = "ics-" + hex.EncodeToString(digest[:])
	event.StartAt, event.EndAt = start.time.Unix(), end.Unix()
	event.AllDay, event.Timezone = start.allDay, start.zone
	if start.allDay {
		event.StartDate = start.wall.Format("2006-01-02")
		event.EndDate = start.wall.AddDate(0, 0, record.length.days).Format("2006-01-02")
	}
	return event, nil
}

func calendarParseRule(prop *ical.Prop, start calendarInstant) (*rrule.ROption, error) {
	if len(prop.Params) != 0 || len(prop.Value) > 2048 {
		return nil, invalid("RRULE contains unsupported parameters or is too long")
	}
	fields := map[string]string{}
	for _, part := range strings.Split(strings.ToUpper(prop.Value), ";") {
		key, value, ok := strings.Cut(part, "=")
		if !ok || value == "" || fields[key] != "" || !oneOf(key, "FREQ", "INTERVAL", "COUNT", "UNTIL", "WKST", "BYDAY", "BYMONTH", "BYMONTHDAY", "BYSETPOS") || len(strings.Split(value, ",")) > 64 {
			return nil, invalid("RRULE contains an unsupported, duplicate or excessive rule part")
		}
		fields[key] = value
	}
	if !oneOf(fields["FREQ"], "DAILY", "WEEKLY", "MONTHLY", "YEARLY") {
		return nil, invalid("RRULE supports DAILY, WEEKLY, MONTHLY and YEARLY only")
	}
	if fields["COUNT"] != "" && fields["UNTIL"] != "" {
		return nil, invalid("RRULE cannot combine COUNT and UNTIL")
	}
	loc, _ := time.LoadLocation(start.zone)
	option, err := rrule.StrToROptionInLocation(strings.ToUpper(prop.Value), loc)
	if err != nil {
		return nil, invalid("RRULE is invalid")
	}
	option.Dtstart = start.time
	if fields["INTERVAL"] == "" {
		option.Interval = 1
	}
	if option.Interval < 1 || option.Interval > 1000 || (fields["COUNT"] != "" && (option.Count < 1 || option.Count > calendarMaxWork)) {
		return nil, invalid("RRULE INTERVAL or COUNT exceeds the supported range")
	}
	if fields["UNTIL"] != "" {
		until := &ical.Prop{Name: "UNTIL", Value: fields["UNTIL"], Params: ical.Params{}}
		if start.allDay {
			until.Params.Set("VALUE", "DATE")
		} else if start.floating {
			if strings.HasSuffix(until.Value, "Z") {
				return nil, invalid("floating DTSTART requires a floating UNTIL")
			}
		} else if !strings.HasSuffix(until.Value, "Z") {
			return nil, invalid("zoned DTSTART requires a UTC UNTIL")
		}
		parsed, err := calendarParseTime(until, loc)
		if err != nil || parsed.allDay != start.allDay || parsed.time.Before(start.time) {
			return nil, invalid("RRULE UNTIL must match DTSTART's value type and not precede it")
		}
		option.Until = parsed.time
	}
	if fields["WKST"] != "" && (len(fields["WKST"]) != 2 || option.Wkst.N() != 0) {
		return nil, invalid("RRULE WKST must name one weekday")
	}
	if option.Freq == rrule.WEEKLY && len(option.Bymonthday) != 0 {
		return nil, invalid("weekly RRULE cannot contain BYMONTHDAY")
	}
	for _, day := range option.Byweekday {
		if day.N() != 0 && (option.Freq == rrule.DAILY || option.Freq == rrule.WEEKLY) {
			return nil, invalid("ordinal BYDAY is supported for monthly/yearly rules only")
		}
		if day.N() < -53 || day.N() > 53 || (option.Freq == rrule.MONTHLY && (day.N() < -5 || day.N() > 5)) {
			return nil, invalid("RRULE BYDAY ordinal is outside the supported range")
		}
	}
	if len(option.Bysetpos) != 0 && len(option.Bymonth) == 0 && len(option.Bymonthday) == 0 && len(option.Byweekday) == 0 {
		return nil, invalid("RRULE BYSETPOS requires another BY rule part")
	}
	if _, err := rrule.NewRRule(*option); err != nil {
		return nil, invalid("RRULE values are invalid")
	}
	return option, nil
}

func calendarExpand(record *calendarRecord, lower, upper time.Time, budget *calendarBudget) (map[string]calendarInstant, error) {
	starts := map[string]calendarInstant{record.start.key(): record.start}
	for _, value := range record.rdates {
		starts[value.key()] = value
	}
	if record.rule == nil {
		return starts, nil
	}
	rule := record.rule
	loc, _ := time.LoadLocation(record.start.zone)
	anchor := calendarPeriodStart(record.start.wall, rule)
	period := anchor
	if rule.Count == 0 {
		local := lower.In(loc)
		wallLower := time.Date(local.Year(), local.Month(), local.Day(), 0, 0, 0, 0, time.UTC)
		period = calendarSeekPeriod(anchor, wallLower, rule)
	}
	upperLocal := upper.In(loc)
	wallUpper := time.Date(upperLocal.Year(), upperLocal.Month(), upperLocal.Day(), 0, 0, 0, 0, time.UTC).AddDate(0, 0, 1)
	if !rule.Until.IsZero() {
		until := rule.Until.In(loc)
		untilDay := time.Date(until.Year(), until.Month(), until.Day(), 0, 0, 0, 0, time.UTC).AddDate(0, 0, 1)
		if untilDay.Before(wallUpper) {
			wallUpper = untilDay
		}
	}
	// DTSTART must agree with its rule; RFC 5545 otherwise leaves the recurrence
	// set undefined. Check even when the requested window is decades later.
	initial, err := calendarPeriodCandidates(anchor, record, budget)
	if err != nil {
		return nil, err
	}
	matchesStart := false
	for _, value := range initial {
		if value.wall.Equal(record.start.wall) {
			matchesStart = true
		}
	}
	if !matchesStart {
		return nil, invalid("DTSTART does not match its RRULE")
	}
	count := 0
	for period.Before(wallUpper) {
		if err := budget.spend(1); err != nil {
			return nil, err
		}
		candidates, err := calendarPeriodCandidates(period, record, budget)
		if err != nil {
			return nil, err
		}
		for _, candidate := range candidates {
			if candidate.time.Before(record.start.time) {
				continue
			}
			if !rule.Until.IsZero() && candidate.time.After(rule.Until) {
				return starts, nil
			}
			count++
			if !candidate.time.Before(lower) && candidate.time.Before(upper) {
				starts[candidate.key()] = candidate
				if len(starts) > calendarMaxDates {
					return nil, invalid("calendar recurrence expansion exceeds the date limit")
				}
			}
			if rule.Count > 0 && count >= rule.Count {
				return starts, nil
			}
		}
		period = calendarNextPeriod(period, rule, rule.Interval)
	}
	return starts, nil
}

func calendarPeriodStart(wall time.Time, rule *rrule.ROption) time.Time {
	day := time.Date(wall.Year(), wall.Month(), wall.Day(), 0, 0, 0, 0, time.UTC)
	switch rule.Freq {
	case rrule.YEARLY:
		return time.Date(day.Year(), 1, 1, 0, 0, 0, 0, time.UTC)
	case rrule.MONTHLY:
		return time.Date(day.Year(), day.Month(), 1, 0, 0, 0, 0, time.UTC)
	case rrule.WEEKLY:
		weekday := (int(day.Weekday()) + 6) % 7
		return day.AddDate(0, 0, -(weekday-rule.Wkst.Day()+7)%7)
	default:
		return day
	}
}

func calendarNextPeriod(period time.Time, rule *rrule.ROption, n int) time.Time {
	switch rule.Freq {
	case rrule.YEARLY:
		return period.AddDate(n, 0, 0)
	case rrule.MONTHLY:
		return period.AddDate(0, n, 0)
	case rrule.WEEKLY:
		return period.AddDate(0, 0, n*7)
	default:
		return period.AddDate(0, 0, n)
	}
}

func calendarSeekPeriod(anchor, target time.Time, rule *rrule.ROption) time.Time {
	if !target.After(anchor) {
		return anchor
	}
	n := 0
	switch rule.Freq {
	case rrule.YEARLY:
		n = target.Year() - anchor.Year()
	case rrule.MONTHLY:
		n = (target.Year()-anchor.Year())*12 + int(target.Month()-anchor.Month())
	case rrule.WEEKLY:
		n = int(target.Sub(anchor) / (7 * 24 * time.Hour))
	default:
		n = int(target.Sub(anchor) / (24 * time.Hour))
	}
	return calendarNextPeriod(anchor, rule, (n/rule.Interval)*rule.Interval)
}

func calendarPeriodCandidates(period time.Time, record *calendarRecord, budget *calendarBudget) ([]calendarInstant, error) {
	rule := record.rule
	end := calendarNextPeriod(period, rule, 1)
	loc, _ := time.LoadLocation(record.start.zone)
	values := []calendarInstant{}
	for day := period; day.Before(end); day = day.AddDate(0, 0, 1) {
		if err := budget.spend(1); err != nil {
			return nil, err
		}
		if !calendarMatchesDay(day, record.start.wall, rule) {
			continue
		}
		wall := time.Date(day.Year(), day.Month(), day.Day(), record.start.wall.Hour(), record.start.wall.Minute(), record.start.wall.Second(), 0, time.UTC)
		instant, ok := calendarWallTime(wall, loc)
		if !ok {
			// RFC 5545 excludes invalid local dates/times, without consuming COUNT.
			continue
		}
		value := record.start
		value.wall, value.time = wall, instant
		values = append(values, value)
	}
	if len(rule.Bysetpos) == 0 {
		return values, nil
	}
	selected := map[int]bool{}
	for _, position := range rule.Bysetpos {
		index := position - 1
		if position < 0 {
			index = len(values) + position
		}
		if index >= 0 && index < len(values) {
			selected[index] = true
		}
	}
	result := []calendarInstant{}
	for index, value := range values {
		if selected[index] {
			result = append(result, value)
		}
	}
	return result, nil
}

func calendarMatchesDay(day, start time.Time, rule *rrule.ROption) bool {
	contains := func(values []int, want int) bool {
		for _, value := range values {
			if value == want {
				return true
			}
		}
		return false
	}
	if len(rule.Bymonth) != 0 && !contains(rule.Bymonth, int(day.Month())) {
		return false
	}
	if len(rule.Bymonthday) != 0 {
		monthDays := time.Date(day.Year(), day.Month()+1, 0, 0, 0, 0, 0, time.UTC).Day()
		if !contains(rule.Bymonthday, day.Day()) && !contains(rule.Bymonthday, day.Day()-monthDays-1) {
			return false
		}
	}
	if len(rule.Byweekday) != 0 {
		match := false
		for _, weekday := range rule.Byweekday {
			if (int(day.Weekday())+6)%7 != weekday.Day() {
				continue
			}
			if weekday.N() == 0 {
				match = true
				break
			}
			index, total := day.Day(), time.Date(day.Year(), day.Month()+1, 0, 0, 0, 0, 0, time.UTC).Day()
			if rule.Freq == rrule.YEARLY && len(rule.Bymonth) == 0 {
				index, total = day.YearDay(), time.Date(day.Year(), 12, 31, 0, 0, 0, 0, time.UTC).YearDay()
			}
			if (weekday.N() > 0 && (index-1)/7+1 == weekday.N()) || (weekday.N() < 0 && -((total-index)/7+1) == weekday.N()) {
				match = true
				break
			}
		}
		if !match {
			return false
		}
	}
	// Omitted BY parts inherit DTSTART's day (and month for YEARLY), rather
	// than accidentally expanding a monthly anniversary to every day.
	if len(rule.Byweekday) == 0 && len(rule.Bymonthday) == 0 {
		switch rule.Freq {
		case rrule.WEEKLY:
			return day.Weekday() == start.Weekday()
		case rrule.MONTHLY:
			return day.Day() == start.Day()
		case rrule.YEARLY:
			return day.Day() == start.Day() && (len(rule.Bymonth) != 0 || day.Month() == start.Month())
		}
	}
	return true
}

func calendarCheckTimezone(component *ical.Component, opts CalendarParseOptions, budget *calendarBudget) error {
	prop, err := calendarSingle(component.Props, "TZID", true)
	if err != nil {
		return err
	}
	loc, err := integrationTimezone(prop.Value)
	if err != nil {
		return invalid("custom VTIMEZONE definitions are not supported; use an IANA TZID or UTC")
	}
	if len(prop.Params) != 0 || len(component.Props["TZURL"]) != 0 || len(component.Children) == 0 || len(component.Children) > 32 {
		return invalid("custom VTIMEZONE overrides are not supported")
	}
	// An embedded definition is accepted only when its observed transitions
	// agree with IANA around the requested window. Merely recognizing TZID is
	// insufficient: a custom definition may reuse an existing IANA name.
	lower := opts.WindowStart.AddDate(0, 0, -370)
	upper := opts.WindowEnd.AddDate(0, 0, 370)
	checked := 0
	fixed := false
	transitions := map[int64]bool{}
	for _, child := range component.Children {
		if !oneOf(child.Name, "STANDARD", "DAYLIGHT") || len(child.Children) != 0 {
			return invalid("unsupported VTIMEZONE observance")
		}
		for _, name := range []string{"DTSTART", "TZOFFSETFROM", "TZOFFSETTO", "RRULE"} {
			if _, err := calendarSingle(child.Props, name, name != "RRULE"); err != nil {
				return invalid("invalid VTIMEZONE observance properties")
			}
		}
		if len(child.Props["EXDATE"]) != 0 || len(child.Props["EXRULE"]) != 0 {
			return invalid("VTIMEZONE exclusions are not supported")
		}
		from, err := calendarTimezoneOffset(child.Props.Get("TZOFFSETFROM"))
		if err != nil {
			return err
		}
		to, err := calendarTimezoneOffset(child.Props.Get("TZOFFSETTO"))
		if err != nil {
			return err
		}
		startProp := child.Props.Get("DTSTART")
		start, err := calendarParseTime(startProp, time.UTC)
		if err != nil || len(startProp.Params) != 0 || start.allDay || !start.floating {
			return invalid("VTIMEZONE DTSTART must be a local date-time")
		}
		// Observance UNTIL uses UTC even though its DTSTART is a local clock.
		// Offsets are accounted for when checking the generated transitions.
		start.floating = false
		record := &calendarRecord{start: start, hasStart: true}
		if ruleProp := child.Props.Get("RRULE"); ruleProp != nil {
			record.rule, err = calendarParseRule(ruleProp, start)
			if err != nil || record.rule.Freq != rrule.YEARLY {
				return invalid("VTIMEZONE supports bounded yearly observance rules only")
			}
			if !record.rule.Until.IsZero() {
				// UTC UNTIL bounds are converted to the observance's wall clock.
				record.rule.Until = record.rule.Until.Add(time.Duration(from) * time.Second)
			}
		}
		for _, dateProp := range child.Props["RDATE"] {
			for _, raw := range strings.Split(dateProp.Value, ",") {
				copy := dateProp
				copy.Value = raw
				date, err := calendarParseTime(&copy, time.UTC)
				if err != nil || len(copy.Params) != 0 || date.allDay || !date.floating {
					return invalid("VTIMEZONE RDATE must contain local date-times")
				}
				budget.dates++
				if budget.dates > calendarMaxDates {
					return invalid("calendar exceeds the explicit recurrence-date limit")
				}
				record.rdates = append(record.rdates, date)
			}
		}
		starts, err := calendarExpand(record, lower.Add(-24*time.Hour), upper.Add(24*time.Hour), budget)
		if err != nil {
			return err
		}
		for _, date := range starts {
			transition := date.time.Add(-time.Duration(from) * time.Second)
			if transition.Before(lower) || !transition.Before(upper) {
				continue
			}
			_, before := transition.Add(-time.Second).In(loc).Zone()
			_, after := transition.In(loc).Zone()
			if before != from || after != to {
				return invalid("VTIMEZONE observance conflicts with its IANA timezone")
			}
			checked++
			transitions[transition.Unix()] = true
		}
		if len(component.Children) == 1 && from == to && record.rule == nil && len(record.rdates) == 0 {
			_, first := lower.In(loc).Zone()
			_, last := upper.In(loc).Zone()
			_, current := opts.WindowStart.In(loc).Zone()
			fixed = first == to && last == to && current == to
		}
	}
	if checked == 0 && !fixed {
		return invalid("VTIMEZONE cannot be verified for the requested calendar window")
	}
	// Check the inverse as well: omitting the fall-back observance must not
	// silently turn a daylight-only definition into the complete IANA zone.
	for cursor := lower.In(loc); cursor.Before(upper); {
		if err := budget.spend(1); err != nil {
			return err
		}
		_, boundary := cursor.ZoneBounds()
		if boundary.IsZero() || !boundary.Before(upper) {
			break
		}
		if !boundary.After(cursor) {
			return invalid("IANA timezone transition cannot be verified")
		}
		_, before := boundary.Add(-time.Second).In(loc).Zone()
		_, after := boundary.In(loc).Zone()
		if before != after && !transitions[boundary.Unix()] {
			return invalid("VTIMEZONE omits an IANA timezone transition in the calendar window")
		}
		cursor = boundary.In(loc)
	}
	return nil
}

func calendarTimezoneOffset(prop *ical.Prop) (int, error) {
	if prop == nil || len(prop.Params) != 0 || (len(prop.Value) != 5 && len(prop.Value) != 7) || (prop.Value[0] != '+' && prop.Value[0] != '-') {
		return 0, invalid("VTIMEZONE has an invalid UTC offset")
	}
	parts := []int{0, 0, 0}
	for i := 1; i < len(prop.Value); i += 2 {
		if prop.Value[i] < '0' || prop.Value[i] > '9' || prop.Value[i+1] < '0' || prop.Value[i+1] > '9' {
			return 0, invalid("VTIMEZONE has an invalid UTC offset")
		}
		n, err := strconv.Atoi(prop.Value[i : i+2])
		if err != nil || n < 0 || n > 59 || (i == 1 && n > 23) {
			return 0, invalid("VTIMEZONE has an invalid UTC offset")
		}
		parts[(i-1)/2] = n
	}
	offset := parts[0]*3600 + parts[1]*60 + parts[2]
	if prop.Value[0] == '-' {
		offset = -offset
	}
	return offset, nil
}
