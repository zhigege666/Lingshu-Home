package home

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"
)

func calendarTestICS(events ...string) []byte {
	return []byte(strings.ReplaceAll("BEGIN:VCALENDAR\nVERSION:2.0\nPRODID:-//Lingshu Home tests//EN\n"+strings.Join(events, "\n")+"\nEND:VCALENDAR\n", "\n", "\r\n"))
}

func calendarTestEvent(body string) string {
	return "BEGIN:VEVENT\n" + body + "\nEND:VEVENT"
}

func calendarTestOptions(t *testing.T, start, end, zone string) CalendarParseOptions {
	t.Helper()
	a, err := time.Parse(time.RFC3339, start)
	if err != nil {
		t.Fatal(err)
	}
	b, err := time.Parse(time.RFC3339, end)
	if err != nil {
		t.Fatal(err)
	}
	return CalendarParseOptions{WindowStart: a, WindowEnd: b, CalendarTimezone: zone}
}

func calendarTestParse(t *testing.T, raw []byte, opts CalendarParseOptions) CalendarData {
	t.Helper()
	data, err := parseCalendarICS(raw, opts)
	if err != nil {
		t.Fatalf("parseCalendarICS: %v", err)
	}
	encoded, err := json.Marshal(data)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := normalizeComponentData("calendar.events", encoded); err != nil {
		t.Fatalf("parser violated the public calendar contract: %v; %s", err, encoded)
	}
	return data
}

func calendarTestStarts(events []CalendarEvent) []string {
	result := []string{}
	for _, event := range events {
		result = append(result, time.Unix(event.StartAt, 0).UTC().Format(time.RFC3339))
	}
	return result
}

func calendarTestWantStarts(t *testing.T, data CalendarData, want ...string) {
	t.Helper()
	got := calendarTestStarts(data.Events)
	if strings.Join(got, ",") != strings.Join(want, ",") {
		t.Fatalf("occurrences = %v, want %v", got, want)
	}
}

func TestCalendarCommonRecurrenceFixtures(t *testing.T) {
	tests := []struct {
		name, body, from, to string
		want                 []string
	}{
		{"daily", "DTSTART:20260301T090000Z\nRRULE:FREQ=DAILY;COUNT=3", "2026-03-01T00:00:00Z", "2026-03-05T00:00:00Z", []string{"2026-03-01T09:00:00Z", "2026-03-02T09:00:00Z", "2026-03-03T09:00:00Z"}},
		{"weekly_days_and_dst", "DTSTART;TZID=America/New_York:20260302T090000\nRRULE:FREQ=WEEKLY;BYDAY=MO,WE,FR;WKST=SU;COUNT=6", "2026-03-01T00:00:00Z", "2026-03-15T00:00:00Z", []string{"2026-03-02T14:00:00Z", "2026-03-04T14:00:00Z", "2026-03-06T14:00:00Z", "2026-03-09T13:00:00Z", "2026-03-11T13:00:00Z", "2026-03-13T13:00:00Z"}},
		{"weekly_interval", "DTSTART:20260302T090000Z\nRRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,WE;COUNT=4", "2026-03-01T00:00:00Z", "2026-04-01T00:00:00Z", []string{"2026-03-02T09:00:00Z", "2026-03-04T09:00:00Z", "2026-03-16T09:00:00Z", "2026-03-18T09:00:00Z"}},
		{"monthly_first_monday", "DTSTART:20260105T090000Z\nRRULE:FREQ=MONTHLY;BYDAY=1MO;COUNT=4", "2026-01-01T00:00:00Z", "2026-04-01T00:00:00Z", []string{"2026-01-05T09:00:00Z", "2026-02-02T09:00:00Z", "2026-03-02T09:00:00Z"}},
		{"monthly_invalid_day_does_not_consume_count", "DTSTART:20260131T090000Z\nRRULE:FREQ=MONTHLY;COUNT=3", "2026-02-01T00:00:00Z", "2026-04-02T00:00:00Z", []string{"2026-03-31T09:00:00Z"}},
		{"monthly_last_day", "DTSTART:20260131T090000Z\nRRULE:FREQ=MONTHLY;BYMONTHDAY=-1;COUNT=3", "2026-01-01T00:00:00Z", "2026-04-01T00:00:00Z", []string{"2026-01-31T09:00:00Z", "2026-02-28T09:00:00Z", "2026-03-31T09:00:00Z"}},
		{"monthly_last_weekday", "DTSTART:20260130T090000Z\nRRULE:FREQ=MONTHLY;BYDAY=MO,TU,WE,TH,FR;BYSETPOS=-1;COUNT=3", "2026-01-01T00:00:00Z", "2026-04-01T00:00:00Z", []string{"2026-01-30T09:00:00Z", "2026-02-27T09:00:00Z", "2026-03-31T09:00:00Z"}},
		{"yearly_leap_day", "DTSTART:20200229T090000Z\nRRULE:FREQ=YEARLY;COUNT=3", "2024-02-01T00:00:00Z", "2024-03-01T00:00:00Z", []string{"2024-02-29T09:00:00Z"}},
		{"yearly_month_weekday", "DTSTART:20240310T090000Z\nRRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU", "2026-03-01T00:00:00Z", "2026-04-01T00:00:00Z", []string{"2026-03-08T09:00:00Z"}},
		{"yearly_ordinal_without_month", "DTSTART:20260105T090000Z\nRRULE:FREQ=YEARLY;BYDAY=1MO", "2027-01-01T00:00:00Z", "2027-02-01T00:00:00Z", []string{"2027-01-04T09:00:00Z"}},
		{"until_inclusive", "DTSTART:20260301T090000Z\nRRULE:FREQ=DAILY;UNTIL=20260303T090000Z", "2026-03-01T00:00:00Z", "2026-03-05T00:00:00Z", []string{"2026-03-01T09:00:00Z", "2026-03-02T09:00:00Z", "2026-03-03T09:00:00Z"}},
		{"rdate_exdate_deduplicate", "DTSTART:20260301T090000Z\nRRULE:FREQ=DAILY;COUNT=4\nRDATE:20260302T090000Z,20260306T090000Z\nEXDATE:20260302T090000Z,20260304T090000Z", "2026-03-01T00:00:00Z", "2026-03-08T00:00:00Z", []string{"2026-03-01T09:00:00Z", "2026-03-03T09:00:00Z", "2026-03-06T09:00:00Z"}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			data := calendarTestParse(t, calendarTestICS(calendarTestEvent("UID:fixture\nSUMMARY:Fixture\n"+test.body)), calendarTestOptions(t, test.from, test.to, "UTC"))
			calendarTestWantStarts(t, data, test.want...)
		})
	}
}

func TestCalendarAllDayExclusiveEndAndDST(t *testing.T) {
	data := calendarTestParse(t, calendarTestICS(
		calendarTestEvent("UID:allday\nSUMMARY:Across DST\nDTSTART;VALUE=DATE:20260307\nDTEND;VALUE=DATE:20260310"),
		calendarTestEvent("UID:default-day\nSUMMARY:One day\nDTSTART;VALUE=DATE:20260311"),
	), calendarTestOptions(t, "2026-03-07T05:00:00Z", "2026-03-12T04:00:00Z", "America/New_York"))
	if len(data.Events) != 2 {
		t.Fatalf("events = %v", data.Events)
	}
	e := data.Events[0]
	if !e.AllDay || e.StartDate != "2026-03-07" || e.EndDate != "2026-03-10" || e.EndAt-e.StartAt != 71*3600 {
		t.Fatalf("lost exclusive date or DST semantics: %+v", e)
	}
	if data.Events[1].EndDate != "2026-03-12" {
		t.Fatalf("a DATE without DTEND must last one day: %+v", data.Events[1])
	}
	boundary := calendarTestParse(t, calendarTestICS(calendarTestEvent("UID:ending\nSUMMARY:Before the window\nDTSTART;VALUE=DATE:20260307\nDTEND;VALUE=DATE:20260310")), calendarTestOptions(t, "2026-03-10T04:00:00Z", "2026-03-11T04:00:00Z", "America/New_York"))
	if len(boundary.Events) != 0 {
		t.Fatal("exclusive end date leaked into the next day")
	}
}

func TestCalendarFloatingAndDSTResolution(t *testing.T) {
	t.Run("floating_uses_configured_timezone", func(t *testing.T) {
		data := calendarTestParse(t, calendarTestICS(calendarTestEvent("UID:floating\nSUMMARY:本地会议\nDTSTART:20261019T090000\nRRULE:FREQ=DAILY;UNTIL=20261020T090000")), calendarTestOptions(t, "2026-10-18T16:00:00Z", "2026-10-21T16:00:00Z", "Asia/Shanghai"))
		calendarTestWantStarts(t, data, "2026-10-19T01:00:00Z", "2026-10-20T01:00:00Z")
		if data.Events[0].Timezone != "Asia/Shanghai" {
			t.Fatal("floating-time interpretation was not retained")
		}
	})
	t.Run("nonexistent_recurrence_is_skipped_without_count", func(t *testing.T) {
		data := calendarTestParse(t, calendarTestICS(calendarTestEvent("UID:gap\nSUMMARY:Early appointment\nDTSTART;TZID=America/New_York:20260307T023000\nRRULE:FREQ=DAILY;COUNT=3")), calendarTestOptions(t, "2026-03-07T00:00:00Z", "2026-03-12T00:00:00Z", "UTC"))
		calendarTestWantStarts(t, data, "2026-03-07T07:30:00Z", "2026-03-09T06:30:00Z", "2026-03-10T06:30:00Z")
	})
	t.Run("ambiguous_clock_selects_first_occurrence", func(t *testing.T) {
		data := calendarTestParse(t, calendarTestICS(calendarTestEvent("UID:fold\nSUMMARY:Repeated hour\nDTSTART;TZID=America/New_York:20261101T013000")), calendarTestOptions(t, "2026-11-01T00:00:00Z", "2026-11-02T00:00:00Z", "UTC"))
		calendarTestWantStarts(t, data, "2026-11-01T05:30:00Z")
	})
}

func TestCalendarDurationPreservesNominalDays(t *testing.T) {
	data := calendarTestParse(t, calendarTestICS(
		calendarTestEvent("UID:nominal\nSUMMARY:Nominal day\nDTSTART;TZID=America/New_York:20260307T120000\nDURATION:P1D"),
		calendarTestEvent("UID:exact\nSUMMARY:24 hours\nDTSTART;TZID=America/New_York:20260307T120000\nDURATION:PT24H"),
	), calendarTestOptions(t, "2026-03-07T00:00:00Z", "2026-03-10T00:00:00Z", "UTC"))
	for _, event := range data.Events {
		want := int64(24 * 3600)
		if event.Title == "Nominal day" {
			want = 23 * 3600
		}
		if event.EndAt-event.StartAt != want {
			t.Fatalf("DURATION day/time distinction lost: %+v", event)
		}
	}
	rdate := calendarTestParse(t, calendarTestICS(calendarTestEvent("UID:rdate-duration\nDTSTART;TZID=America/New_York:20260306T120000\nDURATION:P1D\nRDATE:20260307T170000Z")), calendarTestOptions(t, "2026-03-07T00:00:00Z", "2026-03-10T00:00:00Z", "UTC"))
	for _, event := range rdate.Events {
		if event.StartAt == time.Date(2026, 3, 7, 17, 0, 0, 0, time.UTC).Unix() && event.EndAt-event.StartAt != 23*3600 {
			t.Fatalf("UTC RDATE lost the master's nominal-day timezone: %+v", event)
		}
	}
}

func TestCalendarRecurrenceOverridesAndCancellation(t *testing.T) {
	opts := calendarTestOptions(t, "2026-03-01T00:00:00Z", "2026-03-08T00:00:00Z", "UTC")
	master := calendarTestEvent("UID:series\nSUMMARY:Original\nDTSTART:20260301T090000Z\nDURATION:PT1H\nRRULE:FREQ=DAILY;COUNT=3")
	baseline := calendarTestParse(t, calendarTestICS(master), opts)
	data := calendarTestParse(t, calendarTestICS(master,
		calendarTestEvent("UID:series\nRECURRENCE-ID:20260302T090000Z\nDTSTART:20260305T100000Z\nDTEND:20260305T113000Z\nSUMMARY:Moved"),
		calendarTestEvent("UID:series\nRECURRENCE-ID:20260303T090000Z\nSTATUS:CANCELLED"),
	), opts)
	calendarTestWantStarts(t, data, "2026-03-01T09:00:00Z", "2026-03-05T10:00:00Z")
	if data.Events[1].ID != baseline.Events[1].ID || data.Events[1].Title != "Moved" || data.Events[1].EndAt-data.Events[1].StartAt != 90*60 {
		t.Fatalf("override lost original occurrence identity or modified duration: %+v", data.Events[1])
	}
	// Original instance is outside the requested window, but its move is inside.
	movedWindow := calendarTestParse(t, calendarTestICS(master,
		calendarTestEvent("UID:series\nRECURRENCE-ID:20260302T090000Z\nDTSTART:20260305T100000Z\nSUMMARY:Moved"),
	), calendarTestOptions(t, "2026-03-05T00:00:00Z", "2026-03-06T00:00:00Z", "UTC"))
	calendarTestWantStarts(t, movedWindow, "2026-03-05T10:00:00Z")
	// Some exporters exclude the old position as well as including an override.
	withExdate := strings.Replace(master, "RRULE:", "EXDATE:20260302T090000Z\nRRULE:", 1)
	data = calendarTestParse(t, calendarTestICS(withExdate, calendarTestEvent("UID:series\nRECURRENCE-ID:20260302T090000Z\nDTSTART:20260305T100000Z\nSUMMARY:Moved")), opts)
	calendarTestWantStarts(t, data, "2026-03-01T09:00:00Z", "2026-03-03T09:00:00Z", "2026-03-05T10:00:00Z")
}

func TestCalendarDateRecurrenceExceptions(t *testing.T) {
	data := calendarTestParse(t, calendarTestICS(
		calendarTestEvent("UID:date-series\nSUMMARY:Daily\nDTSTART;VALUE=DATE:20260301\nRRULE:FREQ=DAILY;UNTIL=20260304\nRDATE;VALUE=DATE:20260306\nEXDATE;VALUE=DATE:20260302"),
		calendarTestEvent("UID:date-series\nRECURRENCE-ID;VALUE=DATE:20260303\nDTSTART;VALUE=DATE:20260307\nDURATION:P2D\nSUMMARY:Moved all-day"),
	), calendarTestOptions(t, "2026-03-01T00:00:00Z", "2026-03-09T00:00:00Z", "UTC"))
	calendarTestWantStarts(t, data, "2026-03-01T00:00:00Z", "2026-03-04T00:00:00Z", "2026-03-06T00:00:00Z", "2026-03-07T00:00:00Z")
	if data.Events[3].EndDate != "2026-03-09" {
		t.Fatalf("all-day override end = %q", data.Events[3].EndDate)
	}
}

func TestCalendarFoldedUnicodeAndPlainText(t *testing.T) {
	data := calendarTestParse(t, calendarTestICS(calendarTestEvent("UID:text\nDTSTART:20261019T090000Z\nSUMMARY:设计评审\\, 确认\n 下一步\\n<script>alert(1)</script>\nDESCRIPTION:Line one\\nLine two\\; literal\nLOCATION:会议室\\, 二楼\nURL:javascript:alert(1)")), calendarTestOptions(t, "2026-10-19T00:00:00Z", "2026-10-20T00:00:00Z", "UTC"))
	e := data.Events[0]
	if e.Title != "设计评审, 确认下一步\n<script>alert(1)</script>" || e.Location != "会议室, 二楼" || e.Description != "Line one\nLine two; literal" || e.URL != "" {
		t.Fatalf("incorrect folding, escaping or unsafe URL handling: %+v", e)
	}
}

func TestCalendarRevisionSelection(t *testing.T) {
	data := calendarTestParse(t, calendarTestICS(
		calendarTestEvent("UID:revision\nDTSTART:20260301T090000Z\nSUMMARY:Old\nSEQUENCE:1\nDTSTAMP:20260201T000000Z"),
		calendarTestEvent("UID:revision\nDTSTART:20260301T100000Z\nSUMMARY:New\nSEQUENCE:2\nDTSTAMP:20260202T000000Z"),
	), calendarTestOptions(t, "2026-03-01T00:00:00Z", "2026-03-02T00:00:00Z", "UTC"))
	calendarTestWantStarts(t, data, "2026-03-01T10:00:00Z")
	if data.Events[0].Title != "New" {
		t.Fatal("newest SEQUENCE revision was not selected")
	}
}

func TestCalendarRejectsUnsupportedOrAmbiguousInput(t *testing.T) {
	opts := calendarTestOptions(t, "2026-03-01T00:00:00Z", "2026-04-01T00:00:00Z", "UTC")
	tests := []struct{ name, body, fragment string }{
		{"unknown_timezone", "DTSTART;TZID=Unknown/Custom:20260301T090000", "TZID"},
		{"local_timezone", "DTSTART;TZID=Local:20260301T090000", "TZID"},
		{"dst_gap_start", "DTSTART;TZID=America/New_York:20260308T023000", "nonexistent"},
		{"numeric_offset", "DTSTART:20260301T090000+0800", "format"},
		{"date_tzid", "DTSTART;VALUE=DATE;TZID=Asia/Shanghai:20260301", "DATE"},
		{"multiple_tzid", "DTSTART;TZID=Asia/Shanghai,UTC:20260301T090000", "parameter"},
		{"secondly", "DTSTART:20260301T090000Z\nRRULE:FREQ=SECONDLY", "DAILY"},
		{"hour_expansion", "DTSTART:20260301T090000Z\nRRULE:FREQ=DAILY;BYHOUR=1,2", "unsupported"},
		{"duplicate_rule_part", "DTSTART:20260301T090000Z\nRRULE:FREQ=DAILY;COUNT=2;COUNT=3", "duplicate"},
		{"multiple_rrule", "DTSTART:20260301T090000Z\nRRULE:FREQ=DAILY\nRRULE:FREQ=WEEKLY", "once"},
		{"exrule", "DTSTART:20260301T090000Z\nEXRULE:FREQ=WEEKLY", "EXRULE"},
		{"rdate_period", "DTSTART:20260301T090000Z\nRDATE;VALUE=PERIOD:20260302T090000Z/PT1H", "RDATE"},
		{"exdate_type", "DTSTART:20260301T090000Z\nEXDATE;VALUE=DATE:20260302", "same"},
		{"count_and_until", "DTSTART:20260301T090000Z\nRRULE:FREQ=DAILY;COUNT=2;UNTIL=20260303T090000Z", "combine"},
		{"zero_interval", "DTSTART:20260301T090000Z\nRRULE:FREQ=DAILY;INTERVAL=0", "range"},
		{"bad_month_day", "DTSTART:20260301T090000Z\nRRULE:FREQ=MONTHLY;BYMONTHDAY=0", "invalid"},
		{"range_exception", "DTSTART:20260301T090000Z\nRECURRENCE-ID;RANGE=THISANDFUTURE:20260301T090000Z", "RANGE"},
		{"until_type", "DTSTART:20260301T090000Z\nRRULE:FREQ=DAILY;UNTIL=20260302", "UTC"},
		{"undefined_dtstart", "DTSTART:20260301T090000Z\nRRULE:FREQ=WEEKLY;BYDAY=MO", "does not match"},
		{"mixed_end_type", "DTSTART:20260301T090000Z\nDTEND;VALUE=DATE:20260302", "same value type"},
		{"two_end_definitions", "DTSTART:20260301T090000Z\nDTEND:20260301T100000Z\nDURATION:PT1H", "both"},
		{"zero_duration", "DTSTART:20260301T090000Z\nDURATION:PT0H", "positive"},
		{"missing_dtstart", "SUMMARY:No start", "DTSTART"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			_, err := parseCalendarICS(calendarTestICS(calendarTestEvent("UID:bad\n"+test.body)), opts)
			if err == nil || !strings.Contains(err.Error(), test.fragment) {
				t.Fatalf("error = %v, want containing %q", err, test.fragment)
			}
		})
	}
	t.Run("orphan_exception", func(t *testing.T) {
		_, err := parseCalendarICS(calendarTestICS(calendarTestEvent("UID:missing\nRECURRENCE-ID:20260302T090000Z\nDTSTART:20260304T090000Z")), opts)
		if err == nil || !strings.Contains(err.Error(), "no master") {
			t.Fatalf("error = %v", err)
		}
	})
	t.Run("unrelated_exception", func(t *testing.T) {
		_, err := parseCalendarICS(calendarTestICS(calendarTestEvent("UID:series\nDTSTART:20260301T090000Z\nRRULE:FREQ=DAILY;COUNT=2"), calendarTestEvent("UID:series\nRECURRENCE-ID:20260320T090000Z\nDTSTART:20260321T090000Z")), opts)
		if err == nil || !strings.Contains(err.Error(), "does not identify") {
			t.Fatalf("error = %v", err)
		}
	})
	t.Run("duplicate_revision", func(t *testing.T) {
		e := calendarTestEvent("UID:same\nDTSTART:20260301T090000Z")
		_, err := parseCalendarICS(calendarTestICS(e, e), opts)
		if err == nil || !strings.Contains(err.Error(), "ambiguous") {
			t.Fatalf("error = %v", err)
		}
	})
}

func TestCalendarInputAndExpansionLimits(t *testing.T) {
	opts := calendarTestOptions(t, "2026-03-01T00:00:00Z", "2026-04-01T00:00:00Z", "UTC")
	tests := []struct {
		name     string
		raw      []byte
		fragment string
	}{
		{"bytes", make([]byte, calendarMaxBytes+1), "1 MiB"},
		{"depth", []byte("BEGIN:VCALENDAR\nBEGIN:X\nBEGIN:X\nBEGIN:X\nBEGIN:X\n"), "depth"},
		{"folded_depth", []byte("BEGIN:VCALENDAR\nBEG\n IN:X\nBEG\n IN:X\nBEGIN:X\nBEGIN:X\n"), "depth"},
		{"unterminated", []byte("BEGIN:VCALENDAR\nVERSION:2.0\n"), "unterminated"},
		{"two_calendars", append(calendarTestICS(), calendarTestICS()...), "exactly one"},
		{"invalid_utf8", []byte{0xff, 0xfe}, "UTF-8"},
		{"work", calendarTestICS(calendarTestEvent("UID:old\nDTSTART:16000101T090000Z\nRRULE:FREQ=DAILY;COUNT=100000")), "work limit"},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			_, err := parseCalendarICS(test.raw, opts)
			if err == nil || !strings.Contains(err.Error(), test.fragment) {
				t.Fatalf("error = %v, want %q", err, test.fragment)
			}
		})
	}
	t.Run("event_count", func(t *testing.T) {
		events := make([]string, 501)
		for i := range events {
			events[i] = calendarTestEvent(fmt.Sprintf("UID:many-%d\nDTSTART:20260301T090000Z", i))
		}
		_, err := parseCalendarICS(calendarTestICS(events...), opts)
		if err == nil || !strings.Contains(err.Error(), "500") {
			t.Fatalf("error = %v", err)
		}
	})
	t.Run("long_window", func(t *testing.T) {
		bad := opts
		bad.WindowEnd = bad.WindowStart.AddDate(0, 0, 100)
		_, err := parseCalendarICS(calendarTestICS(), bad)
		if err == nil {
			t.Fatal("unbounded window accepted")
		}
	})
	t.Run("empty_calendar", func(t *testing.T) {
		data := calendarTestParse(t, calendarTestICS(), opts)
		if data.Events == nil || len(data.Events) != 0 {
			t.Fatalf("events = %v", data.Events)
		}
	})
	t.Run("cancelled_master_without_start", func(t *testing.T) {
		data := calendarTestParse(t, calendarTestICS(calendarTestEvent("UID:removed\nSTATUS:CANCELLED")), opts)
		if len(data.Events) != 0 {
			t.Fatal("cancelled master retained")
		}
	})
}

func TestCalendarOptionsRespectLocalDaysAndDoNotMutate(t *testing.T) {
	connection := map[string]string{"timezone": "America/New_York", "pastDays": "1", "futureDays": "2"}
	now, _ := time.Parse(time.RFC3339, "2026-03-08T12:00:00Z")
	opts, err := integrationCalendarOptions(connection, now)
	if err != nil {
		t.Fatal(err)
	}
	if opts.WindowStart.UTC().Format(time.RFC3339) != "2026-03-07T05:00:00Z" || opts.WindowEnd.UTC().Format(time.RFC3339) != "2026-03-10T04:00:00Z" {
		t.Fatalf("options lost local days: %+v", opts)
	}
	defaultConnection := map[string]string{"timezone": "Asia/Shanghai"}
	if _, err := integrationCalendarOptions(defaultConnection, now); err != nil {
		t.Fatal(err)
	}
	if len(defaultConnection) != 1 {
		t.Fatal("calendar options mutated the source connection")
	}
	for _, invalidConnection := range []map[string]string{{"timezone": "Local"}, {"timezone": "UTC", "pastDays": "30", "futureDays": "90"}, {"timezone": "UTC", "futureDays": "0"}} {
		if _, err := integrationCalendarOptions(invalidConnection, now); err == nil {
			t.Fatalf("invalid options accepted: %v", invalidConnection)
		}
	}
}

func TestCalendarEmbeddedTimezoneMustMatchIANA(t *testing.T) {
	daylight := "BEGIN:DAYLIGHT\nDTSTART:20070311T020000\nTZOFFSETFROM:-0500\nTZOFFSETTO:-0400\nRRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=2SU\nEND:DAYLIGHT"
	standard := "BEGIN:STANDARD\nDTSTART:20071104T020000\nTZOFFSETFROM:-0400\nTZOFFSETTO:-0500\nRRULE:FREQ=YEARLY;BYMONTH=11;BYDAY=1SU\nEND:STANDARD"
	zone := "BEGIN:VTIMEZONE\nTZID:America/New_York\n" + daylight + "\n" + standard + "\nEND:VTIMEZONE"
	event := calendarTestEvent("UID:embedded\nSUMMARY:Embedded timezone\nDTSTART;TZID=America/New_York:20260309T090000")
	opts := calendarTestOptions(t, "2026-03-01T00:00:00Z", "2026-04-01T00:00:00Z", "UTC")
	data := calendarTestParse(t, calendarTestICS(zone, event), opts)
	calendarTestWantStarts(t, data, "2026-03-09T13:00:00Z")
	for _, badZone := range []string{
		strings.Replace(zone, "TZOFFSETTO:-0400", "TZOFFSETTO:-0300", 1),
		strings.Replace(zone, standard+"\n", "", 1),
		strings.Replace(zone, "America/New_York", "Custom/New_York", 1),
		strings.Replace(zone, "FREQ=YEARLY", "FREQ=HOURLY", 1),
	} {
		if _, err := parseCalendarICS(calendarTestICS(badZone, event), opts); err == nil {
			t.Fatalf("unsupported or conflicting embedded timezone accepted: %s", badZone)
		}
	}
	fixed := "BEGIN:VTIMEZONE\nTZID:Asia/Shanghai\nBEGIN:STANDARD\nDTSTART:19700101T000000\nTZOFFSETFROM:+0800\nTZOFFSETTO:+0800\nEND:STANDARD\nEND:VTIMEZONE"
	data = calendarTestParse(t, calendarTestICS(fixed, calendarTestEvent("UID:fixed\nDTSTART;TZID=Asia/Shanghai:20260309T090000")), opts)
	calendarTestWantStarts(t, data, "2026-03-09T01:00:00Z")
}

func TestCalendarMalformedInputCannotPanic(t *testing.T) {
	opts := calendarTestOptions(t, "2026-03-01T00:00:00Z", "2026-04-01T00:00:00Z", "UTC")
	for _, line := range []string{"DTSTART;TZID=\"unterminated:20260301T090000", "DTSTART;TZID=\"UTC\"?bad:20260301T090000", "DTSTART;:20260301T090000", "BEGIN;X=Y:BAD"} {
		if _, err := parseCalendarICS(calendarTestICS(calendarTestEvent("UID:broken\n"+line)), opts); err == nil {
			t.Fatalf("malformed content line accepted: %s", line)
		}
	}
}
