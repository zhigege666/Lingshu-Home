package home

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"time"
)

const (
	ModeOpenEdit      = "open_edit"
	ModePublicRead    = "public_read"
	ModePrivateSingle = "private_single"
	ModePrivateMulti  = "private_multi"
)

type Settings struct {
	Initialized         bool   `json:"initialized"`
	SiteName            string `json:"siteName"`
	Mode                string `json:"mode"`
	RegistrationEnabled bool   `json:"registrationEnabled"`
	AutoFetchIcons      bool   `json:"autoFetchIcons"`
	AutoSelectEndpoint  bool   `json:"autoSelectEndpoint"`
	HasOwner            bool   `json:"hasOwner"`
	AuthEpoch           int64  `json:"-"`
}

type User struct {
	ID           string `json:"id"`
	Username     string `json:"username"`
	DisplayName  string `json:"displayName"`
	Role         string `json:"role"`
	IsEnabled    bool   `json:"isEnabled"`
	PasswordHash string `json:"-"`
	Version      int64  `json:"-"`
}

type Space struct {
	ID           string `json:"id"`
	Name         string `json:"name"`
	Kind         string `json:"kind"`
	Published    bool   `json:"published"`
	CanEdit      bool   `json:"canEdit"`
	OwnerUserID  string `json:"-"`
	DataRevision int64  `json:"-"`
	UpdatedAt    string `json:"-"`
}

type Category struct {
	ID         string  `json:"id"`
	SpaceID    string  `json:"spaceId"`
	ParentID   *string `json:"parentId"`
	Name       string  `json:"name"`
	Icon       string  `json:"icon"`
	SortOrder  int     `json:"sortOrder"`
	ExternalID string  `json:"externalId,omitempty"`
	SourceID   string  `json:"sourceId,omitempty"`
}

type Endpoint struct {
	Label     string `json:"label"`
	URL       string `json:"url"`
	Route     string `json:"route,omitempty"`
	ProbePath string `json:"probePath,omitempty"`
}

type Link struct {
	ID          string     `json:"id"`
	SpaceID     string     `json:"spaceId"`
	CategoryID  *string    `json:"categoryId"`
	Title       string     `json:"title"`
	URL         string     `json:"url"`
	Description string     `json:"description"`
	Icon        string     `json:"icon"`
	IconMode    string     `json:"iconMode"`
	Tags        []string   `json:"tags"`
	IsFavorite  bool       `json:"isFavorite"`
	SortOrder   int        `json:"sortOrder"`
	Endpoints   []Endpoint `json:"endpoints"`
	UpdatedAt   string     `json:"updatedAt"`
	ExternalID  string     `json:"externalId,omitempty"`
	SourceID    string     `json:"sourceId,omitempty"`
}

type NavigationData struct {
	Categories []Category `json:"categories"`
	Links      []Link     `json:"links"`
}

type DatasetAttribution struct {
	Name       string `json:"name"`
	URL        string `json:"url"`
	License    string `json:"license"`
	LicenseURL string `json:"licenseUrl"`
}

type DatasetMeta struct {
	SourceUpdatedAt *time.Time          `json:"sourceUpdatedAt"`
	ReceivedAt      time.Time           `json:"receivedAt"`
	LastSuccessAt   time.Time           `json:"lastSuccessAt"`
	Freshness       string              `json:"freshness"`
	LastError       *IntegrationFailure `json:"lastError,omitempty"`
	Attribution     *DatasetAttribution `json:"attribution,omitempty"`
}

type Dataset struct {
	DatasetID     string      `json:"datasetId"`
	SchemaID      string      `json:"schemaId"`
	SchemaVersion int         `json:"schemaVersion"`
	Revision      string      `json:"revision"`
	Data          any         `json:"data"`
	Meta          DatasetMeta `json:"meta"`
}

type Page struct {
	ID       string         `json:"id"`
	SpaceID  string         `json:"spaceId"`
	Name     string         `json:"name"`
	Revision string         `json:"revision"`
	Config   map[string]any `json:"config"`
}

type Dashboard struct {
	Space    Space              `json:"space"`
	Page     Page               `json:"page"`
	Datasets map[string]Dataset `json:"datasets"`
}

type APIError struct {
	Status          int    `json:"-"`
	Code            string `json:"code"`
	Message         string `json:"message"`
	CurrentRevision string `json:"currentRevision,omitempty"`
}

func (e *APIError) Error() string { return e.Message }
func invalid(message string) error {
	return &APIError{Status: 400, Code: "validation_error", Message: message}
}
func unauthorized() error {
	return &APIError{Status: 401, Code: "unauthorized", Message: "Sign in with a valid credential."}
}
func forbidden() error {
	return &APIError{Status: 403, Code: "forbidden", Message: "You do not have permission for this operation."}
}
func missing() error {
	return &APIError{Status: 404, Code: "not_found", Message: "The requested resource was not found."}
}
func conflict(message string) error {
	return &APIError{Status: 409, Code: "conflict", Message: message}
}

type databaseTime struct{ time.Time }

func (t *databaseTime) Scan(value any) error {
	switch v := value.(type) {
	case time.Time:
		t.Time = v.UTC()
		return nil
	case string:
		parsed, err := time.Parse(time.RFC3339Nano, v)
		if err != nil {
			return err
		}
		t.Time = parsed.UTC()
		return nil
	case []byte:
		return t.Scan(string(v))
	default:
		return fmt.Errorf("unsupported timestamp type %T", value)
	}
}

func (t databaseTime) String() string { return t.Time.UTC().Format(time.RFC3339Nano) }

// Persist only precision supported by both providers. Returning nanoseconds before
// a PostgreSQL TIMESTAMPTZ write made the same link differ on its next read.
func nowUTC() string { return time.Now().UTC().Truncate(time.Microsecond).Format(time.RFC3339Nano) }
func nullableID(v *string) any {
	if v == nil || *v == "" {
		return nil
	}
	return *v
}
func jsonString(v any) string { b, _ := json.Marshal(v); return string(b) }
func storageError(err error) error {
	if errors.Is(err, sql.ErrNoRows) {
		return missing()
	}
	return err
}
