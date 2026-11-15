package home

import (
	"database/sql"
	"errors"
	"math"
	"strconv"
	"strings"
)

func formatWorkItemID(number int64) string {
	value := strconv.FormatInt(number, 36)
	if len(value) < 5 {
		value = strings.Repeat("0", 5-len(value)) + value
	}
	return value
}

func workItemRefValid(value string) bool {
	if len(value) < 5 || len(value) > 13 {
		return false
	}
	number, err := strconv.ParseInt(value, 36, 64)
	return err == nil && number > 0 && formatWorkItemID(number) == value
}

func validWorkRequestID(value string) bool {
	if len(value) == 0 || len(value) > 80 {
		return false
	}
	for _, c := range value {
		if c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '.' || c == '_' || c == ':' || c == '-' {
			continue
		}
		return false
	}
	return true
}

// The counter and the item commit together. A rolled-back creation consumes no
// identity; identities of committed items are never reused, including deletion.
func (a *App) allocateWorkItemID(r *Request) (string, error) {
	var number int64
	err := r.Q.QueryRowContext(r.HTTP.Context(), a.store.Query("UPDATE work_item_sequence SET next_number=next_number+1 WHERE id=1 AND next_number<? RETURNING next_number-1"), int64(math.MaxInt64)).Scan(&number)
	if errors.Is(err, sql.ErrNoRows) {
		return "", workConflict("work_id_capacity", "The work item identifier sequence is unavailable or exhausted.", "")
	}
	if err != nil {
		return "", err
	}
	return formatWorkItemID(number), nil
}
