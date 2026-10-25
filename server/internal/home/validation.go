package home

import (
	"net"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"
)

var idPattern = regexp.MustCompile(`^[0-9a-f]{32}$`)
var usernamePattern = regexp.MustCompile(`^[A-Za-z0-9._-]{3,40}$`)
var bindingPattern = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9._:-]{0,63}$`)

func validID(id string) bool { return idPattern.MatchString(id) }

func required(value, label string, limit int) (string, error) {
	value = strings.TrimSpace(value)
	if value == "" || !utf8.ValidString(value) || utf8.RuneCountInString(value) > limit {
		return "", invalid(label + " is required and exceeds no more than " + strconv.Itoa(limit) + " characters.")
	}
	for _, r := range value {
		if unicode.IsControl(r) {
			return "", invalid(label + " must not contain control characters.")
		}
	}
	return value, nil
}

func bounded(value, label string, limit int) error {
	if !utf8.ValidString(value) || utf8.RuneCountInString(value) > limit {
		return invalid(label + " is too long.")
	}
	for _, r := range value {
		if unicode.IsControl(r) && r != '\n' && r != '\t' && r != '\r' {
			return invalid(label + " contains a control character.")
		}
	}
	return nil
}

func sortOrder(value int) error {
	if value < -1_000_000 || value > 1_000_000 {
		return invalid("sortOrder must be between -1000000 and 1000000.")
	}
	return nil
}

var builtinIcons = map[string]bool{}

func init() {
	// Keep this allowlist in sync with assets/icons/manifest.json; the contract test checks both directions.
	for _, name := range strings.Fields(`house compass search bookmark star folder tags layout-grid list panel-left settings sliders-horizontal plus pencil trash upload download external-link link globe sun moon
bot brain-circuit workflow message-square-text scan-text languages audio-lines wand-sparkles cpu image-plus
code-xml puzzle terminal git-branch git-pull-request braces bug package file-code webhook regex test-tube blocks rocket
server database shield activity hard-drive container network cloud router wifi archive monitor lock-keyhole key-round gauge cable refresh-cw server-cog
book-open briefcase notebook-pen library graduation-cap list-checks calendar-days mail users file-text presentation sheet clipboard-list alarm-clock calculator
clapperboard video film disc-3 headphones audio-waveform gamepad-2 image images palette camera brush pen-tool scissors mic tv captions
shopping-cart wallet credit-card chart-no-axes-combined map map-pin plane train-front car utensils heart-pulse dumbbell house-plug cloud-sun coffee gift
newspaper message-circle messages-square rss pen-line radio contact megaphone`) {
		builtinIcons["lucide:"+name] = true
	}
}

func validIcon(value, fallback string) (string, error) {
	if value == "" {
		value = fallback
	}
	if !builtinIcons[value] {
		return "", invalid("Choose an icon from the bundled Lucide collection.")
	}
	return value, nil
}

func canonicalURL(raw string) (string, error) {
	if len(raw) > 4096 || !utf8.ValidString(raw) {
		return "", invalid("URL must be valid UTF-8 and at most 4096 bytes.")
	}
	for _, r := range raw {
		if unicode.IsControl(r) || unicode.IsSpace(r) || r == '\\' {
			return "", invalid("URL must not contain whitespace, control characters or backslashes.")
		}
	}
	u, err := url.Parse(raw)
	if err != nil || u == nil || u.Hostname() == "" || u.User != nil || u.Opaque != "" {
		return "", invalid("URL must be an absolute HTTP or HTTPS address without embedded credentials.")
	}
	u.Scheme = strings.ToLower(u.Scheme)
	if u.Scheme != "http" && u.Scheme != "https" {
		return "", invalid("Only HTTP and HTTPS URLs are supported.")
	}
	port := u.Port()
	if port != "" {
		number, err := strconv.Atoi(port)
		if err != nil || number < 1 || number > 65535 {
			return "", invalid("URL port must be between 1 and 65535.")
		}
	}
	host := strings.ToLower(u.Hostname())
	if strings.ContainsAny(host, "<>\"'{}|") {
		return "", invalid("URL hostname is invalid.")
	}
	if port == "80" && u.Scheme == "http" || port == "443" && u.Scheme == "https" {
		port = ""
	}
	if port != "" {
		u.Host = net.JoinHostPort(host, port)
	} else if strings.Contains(host, ":") {
		u.Host = "[" + host + "]"
	} else {
		u.Host = host
	}
	if u.Path == "" {
		u.Path = "/"
	}
	u.Fragment = ""
	u.RawFragment = ""
	return u.String(), nil
}

func validateCredentials(username, displayName, password string) (string, string, error) {
	username = strings.TrimSpace(username)
	if !usernamePattern.MatchString(username) {
		return "", "", invalid("Username must use 3–40 ASCII letters, digits, dots, underscores or hyphens.")
	}
	if !utf8.ValidString(password) || utf8.RuneCountInString(password) < 10 || utf8.RuneCountInString(password) > 128 || strings.TrimSpace(password) == "" {
		return "", "", invalid("Password must contain 10–128 characters.")
	}
	if displayName == "" {
		displayName = username
	}
	displayName, err := required(displayName, "displayName", 80)
	return username, displayName, err
}

func validMode(mode string) bool {
	return mode == ModeOpenEdit || mode == ModePublicRead || mode == ModePrivateSingle || mode == ModePrivateMulti
}
