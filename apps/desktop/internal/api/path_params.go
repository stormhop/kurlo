package api

import (
	"strings"

	"github.com/stormhop/kurlo/apps/desktop/internal/model"
)

func applyPathParams(rawURL string, rows []model.KeyValue) string {
	values := make(map[string]string, len(rows))
	for _, row := range rows {
		if row.Enabled && row.Key != "" && row.Value != "" {
			values[row.Key] = row.Value
		}
	}
	if len(values) == 0 {
		return rawURL
	}
	start, end := urlPathBounds(rawURL)
	if start < 0 {
		return rawURL
	}
	segments := strings.Split(rawURL[start:end], "/")
	changed := false
	for i, segment := range segments {
		name, ok := pathParamName(segment)
		if !ok {
			continue
		}
		if value, found := values[name]; found {
			segments[i] = escapePathParamValue(value)
			changed = true
		}
	}
	if !changed {
		return rawURL
	}
	return rawURL[:start] + strings.Join(segments, "/") + rawURL[end:]
}

func pathParamName(segment string) (string, bool) {
	if len(segment) < 2 || segment[0] != ':' {
		return "", false
	}
	return segment[1:], true
}

func urlPathBounds(rawURL string) (int, int) {
	end := len(rawURL)
	if i := strings.IndexAny(rawURL, "?#"); i >= 0 {
		end = i
	}
	from := 0
	if i := strings.Index(rawURL[:end], "://"); i >= 0 {
		from = i + 3
	} else if strings.HasPrefix(rawURL, "//") {
		from = 2
	}
	slash := strings.IndexByte(rawURL[from:end], '/')
	if slash < 0 {
		return -1, -1
	}
	return from + slash, end
}

func escapePathParamValue(value string) string {
	var out strings.Builder
	for i := 0; i < len(value); i++ {
		c := value[i]
		if c == '%' && i+2 < len(value) && isHexDigit(value[i+1]) && isHexDigit(value[i+2]) {
			out.WriteByte(c)
			continue
		}
		if pathParamSafeByte(c) {
			out.WriteByte(c)
			continue
		}
		out.WriteByte('%')
		out.WriteByte("0123456789ABCDEF"[c>>4])
		out.WriteByte("0123456789ABCDEF"[c&15])
	}
	return out.String()
}

func pathParamSafeByte(c byte) bool {
	switch {
	case c >= 'a' && c <= 'z', c >= 'A' && c <= 'Z', c >= '0' && c <= '9':
		return true
	}
	return strings.IndexByte("-._~!$&'()*+,;=:@{}", c) >= 0
}

func isHexDigit(c byte) bool {
	return (c >= '0' && c <= '9') || (c >= 'a' && c <= 'f') || (c >= 'A' && c <= 'F')
}
