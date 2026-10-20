package home

import (
	"database/sql"
	"encoding/json"
	"errors"
	"strconv"
	"strings"
	"time"
)

func integrationAttribution(source IntegrationSource) *DatasetAttribution {
	if source.Kind != "weather-open-meteo" {
		return nil
	}
	return &DatasetAttribution{Name: "Open-Meteo", URL: "https://open-meteo.com/", License: "CC BY 4.0", LicenseURL: "https://creativecommons.org/licenses/by/4.0/"}
}
func (a *App) pruneIntegrationReceipts(r *Request, sourceID string, now time.Time) error {
	_, err := r.Q.ExecContext(r.HTTP.Context(), a.store.Query("DELETE FROM integration_receipts WHERE source_id=? AND (received_at < ? OR request_id NOT IN (SELECT request_id FROM integration_receipts WHERE source_id=? ORDER BY received_at DESC,request_id DESC LIMIT 256))"), sourceID, integrationStamp(now.Add(-7*24*time.Hour)), sourceID)
	return err
}
func (a *App) integrationReplayReceipt(r *Request, sourceID, requestID, digest string) (*Response, error) {
	var previousDigest string
	var encoded []byte
	err := r.Q.QueryRowContext(r.HTTP.Context(), a.store.Query("SELECT payload_hash,receipt_json FROM integration_receipts WHERE source_id=? AND request_id=? AND received_at>=?"), sourceID, requestID, integrationStamp(time.Now().Add(-7*24*time.Hour))).Scan(&previousDigest, &encoded)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if previousDigest != digest {
		return nil, conflict("requestId was already used with a different payload")
	}
	var receipt IntegrationReceipt
	if err = json.Unmarshal(encoded, &receipt); err != nil {
		return nil, err
	}
	return ok(receipt), nil
}
func (a *App) deleteIntegrationSource(r *Request) (*Response, error) {
	if r.User == nil {
		return nil, unauthorized()
	}
	s, err := a.requireIntegrationSource(r, r.param("id"), "sources:write", true)
	if err != nil {
		return nil, err
	}
	var in struct {
		ExpectedConfigRevision string `json:"expectedConfigRevision"`
		DetachUnusedBindings   bool   `json:"detachUnusedBindings,omitempty"`
	}
	if err = r.decode(&in); err != nil {
		return nil, err
	}
	if _, err = integrationRevision(in.ExpectedConfigRevision); err != nil {
		return nil, err
	}
	if in.ExpectedConfigRevision != s.ConfigRevision {
		return nil, &APIError{Status: 409, Code: "source_config_conflict", Message: "source configuration changed; reload before deleting", CurrentRevision: s.ConfigRevision}
	}
	rows, err := r.Q.QueryContext(r.HTTP.Context(), a.store.Query("SELECT id,config FROM pages WHERE space_id=?"), s.SpaceID)
	if err != nil {
		return nil, err
	}
	type pageChange struct {
		id     string
		config map[string]any
	}
	changes := []pageChange{}
	bound, active := false, false
	for rows.Next() {
		var id string
		var raw []byte
		if err = rows.Scan(&id, &raw); err != nil {
			break
		}
		var config map[string]any
		if err = json.Unmarshal(raw, &config); err != nil {
			break
		}
		bindings, _ := object(config["bindings"])
		aliases := map[string]bool{}
		for alias, rawBinding := range bindings {
			binding, _ := object(rawBinding)
			if binding["datasetId"] == s.DatasetID {
				aliases[alias] = true
				bound = true
			}
		}
		views, _ := config["views"].([]any)
		for _, rawView := range views {
			view, _ := object(rawView)
			inputs, _ := object(view["inputs"])
			for _, rawAlias := range inputs {
				alias, _ := rawAlias.(string)
				if aliases[alias] {
					active = true
				}
			}
		}
		if len(aliases) > 0 {
			for alias := range aliases {
				delete(bindings, alias)
			}
			changes = append(changes, pageChange{id, config})
		}
	}
	if err == nil {
		err = rows.Err()
	}
	rows.Close()
	if err != nil {
		return nil, err
	}
	if active || (bound && !in.DetachUnusedBindings) {
		return nil, &APIError{Status: 409, Code: "source_in_use", Message: "source is bound to a page; remove component references or explicitly detach unused bindings"}
	}
	for _, change := range changes {
		_, err = r.Q.ExecContext(r.HTTP.Context(), a.store.Query("UPDATE pages SET config=?,revision=revision+1 WHERE id=?"), jsonString(change.config), change.id)
		if err != nil {
			return nil, err
		}
	}
	_, err = r.Q.ExecContext(r.HTTP.Context(), a.store.Query("DELETE FROM integration_sources WHERE id=?"), s.ID)
	if err != nil {
		return nil, err
	}
	r.WakeIntegrations = true
	return &Response{Status: 204}, nil
}
func (a *App) importIntegrationCalendar(r *Request) (*Response, error) {
	if r.User == nil {
		return nil, unauthorized()
	}
	s, err := a.requireIntegrationSource(r, r.param("id"), "datasets:write", true)
	if err != nil {
		return nil, err
	}
	if s.Kind != "external-push" || s.SchemaID != "calendar.events" {
		return nil, invalid("calendar imports require an external-push calendar.events source")
	}
	var in struct {
		RequestID        string `json:"requestId"`
		ExpectedRevision string `json:"expectedRevision"`
		ICSText          string `json:"icsText"`
		Timezone         string `json:"timezone"`
		PastDays         *int   `json:"pastDays,omitempty"`
		FutureDays       *int   `json:"futureDays,omitempty"`
	}
	if err = r.decode(&in); err != nil {
		return nil, err
	}
	if !integrationExternalID.MatchString(in.RequestID) || len(in.ICSText) == 0 || len(in.ICSText) > 1<<20 {
		return nil, invalid("invalid requestId or ICS file exceeds 1 MiB")
	}
	if _, err = integrationRevision(in.ExpectedRevision); err != nil {
		return nil, err
	}
	// Hash the original import request before deriving its time window. A retry
	// after midnight returns the original receipt without re-expanding the file.
	canonical, _ := json.Marshal(in)
	digest := integrationHash("calendar-import/v1:" + string(canonical))
	if replay, err := a.integrationReplayReceipt(r, s.ID, in.RequestID, digest); err != nil || replay != nil {
		return replay, err
	}
	connection := map[string]string{"timezone": strings.TrimSpace(in.Timezone)}
	if in.PastDays != nil {
		connection["pastDays"] = strconv.Itoa(*in.PastDays)
	}
	if in.FutureDays != nil {
		connection["futureDays"] = strconv.Itoa(*in.FutureDays)
	}
	opts, err := integrationCalendarOptions(connection, time.Now())
	if err != nil {
		return nil, err
	}
	data, err := parseCalendarICS([]byte(in.ICSText), opts)
	if err != nil {
		failure := componentDataFailure("calendar-ics", err)
		return nil, &APIError{Status: 400, Code: failure.Code, Message: failure.Message}
	}
	encoded, err := json.Marshal(data)
	if err != nil {
		return nil, invalid("calendar data could not be encoded")
	}
	return a.acceptIntegrationSnapshot(r, s, integrationPushInput{RequestID: in.RequestID, ExpectedRevision: &in.ExpectedRevision, SchemaID: "calendar.events", SchemaVersion: 1, Data: encoded}, digest)
}
