package home

import (
	"sort"
	"time"
	_ "time/tzdata"
)

type WorkScheduleRule struct {
	Frequency       string `json:"frequency"`
	Time            string `json:"time"`
	Timezone        string `json:"timezone"`
	StartDate       string `json:"startDate"`
	EndDate         string `json:"endDate,omitempty"`
	Weekdays        []int  `json:"weekdays,omitempty"`
	MonthDay        int    `json:"monthDay,omitempty"`
	MonthPolicy     string `json:"monthPolicy,omitempty"`
	DueTime         string `json:"dueTime,omitempty"`
	DueDayOffset    int    `json:"dueDayOffset,omitempty"`
	DueAfterMinutes int    `json:"dueAfterMinutes,omitempty"`
}

type WorkSchedulePreview struct {
	BusinessDate string `json:"businessDate"`
	ScheduledAt  string `json:"scheduledAt"`
	DueAt        string `json:"dueAt"`
}

func validateWorkScheduleRule(rule *WorkScheduleRule) error {
	if _, err := workLocation(rule.Timezone); err != nil {
		return err
	}
	if !validWorkClock(rule.Time) || !validWorkDate(rule.StartDate) || rule.EndDate != "" && (!validWorkDate(rule.EndDate) || rule.EndDate < rule.StartDate) {
		return invalid("Use HH:MM time and actual YYYY-MM-DD startDate/endDate in chronological order.")
	}
	switch rule.Frequency {
	case "daily", "weekdays":
		if len(rule.Weekdays) != 0 || rule.MonthDay != 0 || rule.MonthPolicy != "" {
			return invalid("Daily/weekday rules do not accept weekdays or monthly options.")
		}
	case "weekly":
		if len(rule.Weekdays) == 0 || len(rule.Weekdays) > 7 || rule.MonthDay != 0 || rule.MonthPolicy != "" {
			return invalid("Weekly rules require weekdays (Monday=1 through Sunday=7) and no monthly options.")
		}
		sort.Ints(rule.Weekdays)
		for i, day := range rule.Weekdays {
			if day < 1 || day > 7 || i > 0 && day == rule.Weekdays[i-1] {
				return invalid("weekdays must contain unique integers from 1 through 7.")
			}
		}
	case "monthly":
		if len(rule.Weekdays) != 0 || rule.MonthDay < 1 || rule.MonthDay > 31 || rule.MonthPolicy != "skip" && rule.MonthPolicy != "last_day" {
			return invalid("Monthly rules require monthDay 1–31 and explicit monthPolicy skip or last_day.")
		}
	default:
		return invalid("frequency must be daily, weekdays, weekly or monthly.")
	}
	if rule.DueTime != "" && !validWorkClock(rule.DueTime) || rule.DueDayOffset < 0 || rule.DueDayOffset > 7 || rule.DueAfterMinutes < 0 || rule.DueAfterMinutes > 10080 {
		return invalid("Use a valid dueTime, dueDayOffset 0–7 or dueAfterMinutes 1–10080.")
	}
	if rule.DueTime != "" && rule.DueAfterMinutes != 0 || rule.DueDayOffset != 0 && rule.DueTime == "" {
		return invalid("dueTime and dueAfterMinutes are alternatives; dueDayOffset requires dueTime.")
	}
	if rule.DueTime != "" && rule.DueDayOffset == 0 && rule.DueTime < rule.Time {
		return invalid("dueTime cannot precede generation time on the same day.")
	}
	return nil
}

func validWorkClock(value string) bool {
	at, err := time.Parse("15:04", value)
	return err == nil && at.Format("15:04") == value
}

func workScheduleDate(rule WorkScheduleRule, date string) (WorkSchedulePreview, bool) {
	result := WorkSchedulePreview{BusinessDate: date}
	if !validWorkDate(date) || date < rule.StartDate || rule.EndDate != "" && date > rule.EndDate {
		return result, false
	}
	day, _ := time.Parse("2006-01-02", date)
	weekday := int(day.Weekday())
	if weekday == 0 {
		weekday = 7
	}
	switch rule.Frequency {
	case "weekdays":
		if weekday > 5 {
			return result, false
		}
	case "weekly":
		found := false
		for _, candidate := range rule.Weekdays {
			found = found || candidate == weekday
		}
		if !found {
			return result, false
		}
	case "monthly":
		desired := rule.MonthDay
		last := time.Date(day.Year(), day.Month()+1, 0, 0, 0, 0, 0, time.UTC).Day()
		if desired > last && rule.MonthPolicy == "last_day" {
			desired = last
		}
		if day.Day() != desired {
			return result, false
		}
	}
	location, err := workLocation(rule.Timezone)
	if err != nil {
		return result, false // Stored rules are validated before persistence.
	}
	clock, _ := time.Parse("15:04", rule.Time)
	at := time.Date(day.Year(), day.Month(), day.Day(), clock.Hour(), clock.Minute(), 0, 0, location)
	// A nonexistent wall-clock minute (spring DST transition) is skipped.
	// A repeated minute produces only one occurrence, keyed by business date.
	if at.Format("2006-01-02 15:04") != date+" "+rule.Time {
		return result, false
	}
	result.ScheduledAt = workScheduleStamp(at)
	if rule.DueAfterMinutes > 0 {
		result.DueAt = workScheduleStamp(at.Add(time.Duration(rule.DueAfterMinutes) * time.Minute))
	} else if rule.DueTime != "" {
		clock, _ = time.Parse("15:04", rule.DueTime)
		dueDay := day.AddDate(0, 0, rule.DueDayOffset)
		due := time.Date(dueDay.Year(), dueDay.Month(), dueDay.Day(), clock.Hour(), clock.Minute(), 0, 0, location)
		if due.Format("2006-01-02 15:04") != dueDay.Format("2006-01-02")+" "+rule.DueTime {
			return result, false
		}
		result.DueAt = workScheduleStamp(due)
	}
	return result, true
}

// Every supported frequency has a matching day within 370 days. Iteration is
// bounded independently of the age of a rule, including after long downtime.
func nextWorkSchedule(rule WorkScheduleRule, after time.Time) (WorkSchedulePreview, bool) {
	location, err := workLocation(rule.Timezone)
	if err != nil {
		return WorkSchedulePreview{}, false
	}
	date := after.In(location).Format("2006-01-02")
	if date < rule.StartDate {
		date = rule.StartDate
	}
	day, _ := time.Parse("2006-01-02", date)
	for i := 0; i < 370; i++ {
		date = day.Format("2006-01-02")
		if day.Year() > 9999 || rule.EndDate != "" && date > rule.EndDate {
			break
		}
		if occurrence, matches := workScheduleDate(rule, date); matches {
			at, _ := time.Parse(time.RFC3339Nano, occurrence.ScheduledAt)
			if at.After(after) {
				return occurrence, true
			}
		}
		day = day.AddDate(0, 0, 1)
	}
	return WorkSchedulePreview{}, false
}

func nextWorkScheduleStamp(rule WorkScheduleRule, after time.Time) string {
	occurrence, _ := nextWorkSchedule(rule, after)
	return occurrence.ScheduledAt
}

func recentWorkSchedules(rule WorkScheduleRule, since, now time.Time, limit int) []WorkSchedulePreview {
	location, _ := workLocation(rule.Timezone)
	date := now.In(location).Format("2006-01-02")
	if rule.EndDate != "" && date > rule.EndDate {
		date = rule.EndDate
	}
	day, _ := time.Parse("2006-01-02", date)
	result := []WorkSchedulePreview{}
	for i := 0; i < 370 && len(result) < limit; i++ {
		date = day.Format("2006-01-02")
		if date < rule.StartDate {
			break
		}
		if occurrence, matches := workScheduleDate(rule, date); matches {
			at, _ := time.Parse(time.RFC3339Nano, occurrence.ScheduledAt)
			if at.Before(since) {
				break
			}
			if !at.After(now) {
				result = append(result, occurrence)
			}
		}
		day = day.AddDate(0, 0, -1)
	}
	for left, right := 0, len(result)-1; left < right; left, right = left+1, right-1 {
		result[left], result[right] = result[right], result[left]
	}
	return result
}
