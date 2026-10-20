package home

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/xml"
	"errors"
	"image"
	_ "image/jpeg"
	"image/png"
	"io"
	"math"
	"regexp"
	"strconv"
	"strings"
)

const (
	iconMaxBytes     = 256 << 10
	iconMaxDimension = 512
)

type normalizedIcon struct {
	Content   []byte
	MediaType string
	Digest    string
	Width     int
	Height    int
}

func normalizeIcon(body []byte, mediaType string) (normalizedIcon, error) {
	if len(body) == 0 || len(body) > iconMaxBytes {
		return normalizedIcon{}, invalid("Each icon must contain 1 to 262144 bytes.")
	}
	var out normalizedIcon
	var err error
	switch mediaType {
	case "image/svg+xml":
		out.Content, out.Width, out.Height, err = sanitizeIconSVG(body)
		out.MediaType = "image/svg+xml"
	case "image/png", "image/jpeg":
		var config image.Config
		var format string
		config, format, err = image.DecodeConfig(bytes.NewReader(body))
		if err != nil || config.Width < 1 || config.Height < 1 || config.Width > iconMaxDimension || config.Height > iconMaxDimension || (mediaType == "image/png" && format != "png") || (mediaType == "image/jpeg" && format != "jpeg") {
			return normalizedIcon{}, invalid("Use a valid PNG or JPEG icon with dimensions from 1 to 512 px.")
		}
		var decoded image.Image
		decoded, _, err = image.Decode(bytes.NewReader(body))
		if err == nil {
			var encoded bytes.Buffer
			err = png.Encode(&encoded, decoded)
			out.Content = encoded.Bytes()
			out.Width, out.Height = config.Width, config.Height
		}
		out.MediaType = "image/png"
	default:
		return normalizedIcon{}, invalid("Icons support PNG, JPEG, or a static geometry-only SVG.")
	}
	if err != nil {
		return normalizedIcon{}, invalid("The icon could not be decoded or contains unsupported SVG content.")
	}
	if len(out.Content) > iconMaxBytes {
		return normalizedIcon{}, invalid("The normalized icon exceeds 262144 bytes; use a smaller image.")
	}
	digest := sha256.Sum256(out.Content)
	out.Digest = hex.EncodeToString(digest[:])
	return out, nil
}

var iconSVGNumber = regexp.MustCompile(`^[+-]?(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?$`)
var iconSVGPath = regexp.MustCompile(`^[MmZzLlHhVvCcSsQqTtAa0-9eE+., \t\r\n-]+$`)
var iconSVGColor = regexp.MustCompile(`^(?:none|currentColor|black|white|transparent|#[0-9A-Fa-f]{3}|#[0-9A-Fa-f]{4}|#[0-9A-Fa-f]{6}|#[0-9A-Fa-f]{8})$`)
var iconSVGTransform = regexp.MustCompile(`^(?:(?:matrix|translate|scale|rotate|skewX|skewY)\([0-9eE+., \t\r\n-]+\)[ \t\r\n]*)+$`)

func iconFiniteNumber(raw string) (float64, bool) {
	if len(raw) > 32 || !iconSVGNumber.MatchString(raw) {
		return 0, false
	}
	n, err := strconv.ParseFloat(raw, 64)
	return n, err == nil && !math.IsNaN(n) && !math.IsInf(n, 0) && math.Abs(n) <= 100000
}

func iconSVGNumbers(raw string, count int) ([]float64, bool) {
	parts := strings.Fields(strings.ReplaceAll(raw, ",", " "))
	if count > 0 && len(parts) != count || len(parts) == 0 || len(parts) > 1024 {
		return nil, false
	}
	values := make([]float64, len(parts))
	for i, part := range parts {
		var ok bool
		values[i], ok = iconFiniteNumber(part)
		if !ok {
			return nil, false
		}
	}
	return values, true
}

// SVG is parsed and re-encoded from an allowlist of static shapes. No script,
// style, external reference, namespace extension, animation or embedded image
// survives. These bytes are served as an image, never inserted into HTML.
func sanitizeIconSVG(body []byte) ([]byte, int, int, error) {
	if len(body) > 64<<10 {
		return nil, 0, 0, errors.New("SVG too large")
	}
	decoder := xml.NewDecoder(bytes.NewReader(body))
	var out bytes.Buffer
	encoder := xml.NewEncoder(&out)
	depth, count, width, height := 0, 0, 0, 0
	rootSeen := false
	for {
		token, err := decoder.Token()
		if err == io.EOF {
			break
		}
		if err != nil {
			return nil, 0, 0, err
		}
		switch value := token.(type) {
		case xml.StartElement:
			count++
			depth++
			if depth > 16 || count > 512 || len(value.Attr) > 32 || (value.Name.Space != "" && value.Name.Space != "http://www.w3.org/2000/svg") {
				return nil, 0, 0, errors.New("unsupported SVG structure")
			}
			name := value.Name.Local
			if depth == 1 {
				if rootSeen || name != "svg" {
					return nil, 0, 0, errors.New("one SVG root required")
				}
				rootSeen = true
			} else if name != "g" && name != "path" && name != "rect" && name != "circle" && name != "ellipse" && name != "line" && name != "polyline" && name != "polygon" {
				return nil, 0, 0, errors.New("unsupported SVG element")
			}
			clean := xml.StartElement{Name: xml.Name{Local: name}}
			seen := map[string]bool{}
			if depth == 1 {
				clean.Attr = append(clean.Attr, xml.Attr{Name: xml.Name{Local: "xmlns"}, Value: "http://www.w3.org/2000/svg"})
			}
			for _, attr := range value.Attr {
				key, val := attr.Name.Local, strings.TrimSpace(attr.Value)
				if attr.Name.Space == "" && key == "xmlns" && val == "http://www.w3.org/2000/svg" && depth == 1 {
					continue
				}
				if attr.Name.Space != "" || seen[key] || len(val) > 16384 {
					return nil, 0, 0, errors.New("unsupported SVG attribute")
				}
				seen[key] = true
				valid := false
				switch key {
				case "viewBox":
					values, ok := iconSVGNumbers(val, 4)
					valid = depth == 1 && ok && values[2] > 0 && values[2] <= iconMaxDimension && values[3] > 0 && values[3] <= iconMaxDimension
					if valid {
						width, height = int(math.Ceil(values[2])), int(math.Ceil(values[3]))
					}
				case "width", "height":
					n, ok := iconFiniteNumber(strings.TrimSuffix(val, "px"))
					valid = ok && n > 0 && n <= iconMaxDimension
				case "x", "y", "x1", "x2", "y1", "y2", "cx", "cy", "r", "rx", "ry", "stroke-width", "stroke-dashoffset", "stroke-miterlimit":
					_, valid = iconFiniteNumber(val)
				case "fill", "stroke":
					valid = iconSVGColor.MatchString(val)
				case "opacity", "fill-opacity", "stroke-opacity":
					n, ok := iconFiniteNumber(val)
					valid = ok && n >= 0 && n <= 1
				case "fill-rule", "clip-rule":
					valid = val == "nonzero" || val == "evenodd"
				case "stroke-linecap":
					valid = val == "butt" || val == "round" || val == "square"
				case "stroke-linejoin":
					valid = val == "miter" || val == "round" || val == "bevel"
				case "d":
					valid = name == "path" && iconSVGPath.MatchString(val)
				case "points":
					values, ok := iconSVGNumbers(val, 0)
					valid = (name == "polygon" || name == "polyline") && ok && len(values)%2 == 0
				case "stroke-dasharray":
					_, valid = iconSVGNumbers(val, 0)
				case "transform":
					valid = len(val) < 2048 && iconSVGTransform.MatchString(val)
				case "vector-effect":
					valid = val == "non-scaling-stroke"
				}
				if !valid {
					return nil, 0, 0, errors.New("unsupported SVG attribute value")
				}
				clean.Attr = append(clean.Attr, xml.Attr{Name: xml.Name{Local: key}, Value: val})
			}
			if depth == 1 && (width == 0 || height == 0) {
				return nil, 0, 0, errors.New("a bounded viewBox is required")
			}
			if err = encoder.EncodeToken(clean); err != nil {
				return nil, 0, 0, err
			}
		case xml.EndElement:
			depth--
			if err = encoder.EncodeToken(xml.EndElement{Name: xml.Name{Local: value.Name.Local}}); err != nil {
				return nil, 0, 0, err
			}
		case xml.CharData:
			if strings.TrimSpace(string(value)) != "" {
				return nil, 0, 0, errors.New("SVG text is unsupported")
			}
		case xml.Comment:
			// Comments are intentionally discarded from the canonical image.
		default:
			return nil, 0, 0, errors.New("SVG declarations and directives are unsupported")
		}
	}
	if !rootSeen || depth != 0 {
		return nil, 0, 0, errors.New("incomplete SVG")
	}
	if err := encoder.Flush(); err != nil {
		return nil, 0, 0, err
	}
	return out.Bytes(), width, height, nil
}
