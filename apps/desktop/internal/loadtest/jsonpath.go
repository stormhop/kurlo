package loadtest

import (
	"fmt"
	"strconv"
	"strings"
)

func jsonPathToGJSON(path string) (string, error) {
	text := strings.TrimSpace(path)
	if !strings.HasPrefix(text, "$") {
		return "", fmt.Errorf("JSON path %q must start with $", path)
	}
	var segments []string
	rest := text[1:]
	for rest != "" {
		switch rest[0] {
		case '.':
			rest = rest[1:]
			end := strings.IndexAny(rest, ".[")
			if end < 0 {
				end = len(rest)
			}
			name := rest[:end]
			if name == "" {
				return "", fmt.Errorf("JSON path %q has an empty name", path)
			}
			if name == "*" {
				return "", fmt.Errorf("JSON path %q uses a wildcard, which k6 cannot read", path)
			}
			segments = append(segments, escapeGJSON(name))
			rest = rest[end:]
		case '[':
			end := -1
			var quote byte
			for i := 1; i < len(rest); i++ {
				if quote != 0 {
					if rest[i] == '\\' {
						i++
					} else if rest[i] == quote {
						quote = 0
					}
				} else if rest[i] == '\'' || rest[i] == '"' {
					quote = rest[i]
				} else if rest[i] == ']' {
					end = i
					break
				}
			}
			if end < 0 {
				return "", fmt.Errorf("JSON path %q has an unclosed [", path)
			}
			inner := strings.TrimSpace(rest[1:end])
			rest = rest[end+1:]
			if len(inner) >= 2 && (inner[0] == '\'' || inner[0] == '"') && inner[len(inner)-1] == inner[0] {
				segments = append(segments, escapeGJSON(inner[1:len(inner)-1]))
				continue
			}
			index, err := strconv.Atoi(inner)
			if err != nil || index < 0 {
				return "", fmt.Errorf("JSON path %q has an index k6 cannot read: [%s]", path, inner)
			}
			segments = append(segments, strconv.Itoa(index))
		default:
			return "", fmt.Errorf("JSON path %q is not understood after %q", path, text[:len(text)-len(rest)])
		}
	}
	return strings.Join(segments, "."), nil
}

func escapeGJSON(name string) string {
	var out strings.Builder
	for _, r := range name {
		switch r {
		case '.', '*', '?', '|', '#', '@', '\\', '!', '=', '<', '>', '%', '[', ']':
			out.WriteByte('\\')
		}
		out.WriteRune(r)
	}
	return out.String()
}
