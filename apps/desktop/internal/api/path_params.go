package api

import (
	"strings"

	"github.com/stormhop/kurlo/apps/desktop/internal/model"
	"github.com/stormhop/kurlo/apps/desktop/internal/util"
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
			segments[i] = util.EscapePathParamValue(value)
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
