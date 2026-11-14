package home

import (
	"strings"
	"time"
)

func validWorkDate(value string) bool {
	parsed, err := time.Parse("2006-01-02", value)
	return err == nil && parsed.Year() >= 1 && parsed.Format("2006-01-02") == value
}

func validateWorkDates(in *workCreateInput) error {
	if in.BusinessDate != "" && !validWorkDate(in.BusinessDate) {
		return invalid("businessDate must be an actual YYYY-MM-DD date or empty.")
	}
	if in.DueAt != "" {
		parsed, err := time.Parse(time.RFC3339Nano, in.DueAt)
		if err != nil || parsed.Year() < 1 || parsed.Year() > 9999 {
			return invalid("dueAt must be an RFC3339 timestamp with an offset or empty.")
		}
		in.DueAt = workScheduleStamp(parsed)
	}
	return nil
}

// Fixed UTC precision gives TEXT timestamps a chronological index ordering.
func workScheduleStamp(at time.Time) string {
	return at.UTC().Format("2006-01-02T15:04:05.000000000Z")
}

func workLocation(name string) (*time.Location, error) {
	if len(name) > 100 || name == "" || name == "Local" || strings.Contains(name, "..") {
		return nil, invalid("timezone must be an IANA timezone such as Asia/Shanghai or UTC.")
	}
	location, err := time.LoadLocation(name)
	if err != nil {
		return nil, invalid("Unknown IANA timezone.")
	}
	return location, nil
}
