package home

import (
	"encoding/json"
	"net/http"
)

// Module settings are instance-wide switches, independent of account and token
// permissions. Disabling a module never deletes its records or relationships.
type ModuleSettings struct {
	Documents bool `json:"documents"`
	Work      bool `json:"work"`
}

type moduleSettingsInput struct {
	documents *bool
	work      *bool
}

func (in *moduleSettingsInput) UnmarshalJSON(raw []byte) error {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(raw, &fields); err != nil || fields == nil {
		return invalid("modules must be an object")
	}
	for name, rawValue := range fields {
		if name != "documents" && name != "work" {
			return invalid("Unknown module setting: " + name)
		}
		var value *bool
		if err := json.Unmarshal(rawValue, &value); err != nil || value == nil {
			return invalid("modules." + name + " must be a boolean")
		}
		if name == "documents" {
			in.documents = value
		} else {
			in.work = value
		}
	}
	return nil
}

func (in moduleSettingsInput) apply(current ModuleSettings) ModuleSettings {
	if in.documents != nil {
		current.Documents = *in.documents
	}
	if in.work != nil {
		current.Work = *in.work
	}
	return current
}

// Call this after the handler's existing authorization checks. The global
// switches are public bootstrap metadata, but do not replace resource access.
func (r *Request) requireModule(module string) error {
	enabled := false
	switch module {
	case "documents":
		enabled = r.Settings.Modules.Documents
	case "work":
		enabled = r.Settings.Modules.Work
	default:
		return invalid("Unknown module.")
	}
	if enabled {
		return nil
	}
	return moduleDisabled(module)
}

func moduleDisabled(module string) error {
	return &APIError{Status: http.StatusForbidden, Code: "module_disabled", Message: "This module is disabled by the instance owner.", Details: map[string]any{"module": module}}
}
