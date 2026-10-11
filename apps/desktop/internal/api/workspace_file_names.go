package api

import (
	"fmt"
	"regexp"
	"strings"
	"unicode"

	"golang.org/x/text/unicode/norm"
)

var cyrillicToLatin = map[rune]string{
	'а': "a", 'б': "b", 'в': "v", 'г': "g", 'д': "d", 'е': "e", 'ё': "yo", 'ж': "zh", 'з': "z", 'и': "i",
	'й': "y", 'к': "k", 'л': "l", 'м': "m", 'н': "n", 'о': "o", 'п': "p", 'р': "r", 'с': "s", 'т': "t",
	'у': "u", 'ф': "f", 'х': "kh", 'ц': "ts", 'ч': "ch", 'ш': "sh", 'щ': "shch", 'ъ': "", 'ы': "y", 'ь': "",
	'э': "e", 'ю': "yu", 'я': "ya", 'і': "i", 'ї': "yi", 'є': "ye", 'ґ': "g", 'ў': "u",
}

var windowsReservedName = regexp.MustCompile(`(?i)^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$`)

func transliterateName(name string) string {
	var out strings.Builder
	for _, r := range norm.NFC.String(name) {
		lower := unicode.ToLower(r)
		latin, ok := cyrillicToLatin[lower]
		if !ok {
			out.WriteRune(r)
			continue
		}
		if lower != r && latin != "" {
			latin = strings.ToUpper(latin[:1]) + latin[1:]
		}
		out.WriteString(latin)
	}
	var plain strings.Builder
	for _, r := range norm.NFD.String(out.String()) {
		if !unicode.Is(unicode.Mn, r) {
			plain.WriteRune(r)
		}
	}
	return plain.String()
}

func fileNameForName(name string) string {
	if strings.TrimSpace(name) == "" {
		return ""
	}
	segment := safePathSegment(transliterateName(name))
	if windowsReservedName.MatchString(segment) {
		segment += "-item"
	}
	return segment
}

func segmentFitsName(segment, base string) bool {
	if strings.EqualFold(segment, base) {
		return true
	}
	prefix := base + "-"
	if len(segment) <= len(prefix) || !strings.EqualFold(segment[:len(prefix)], prefix) {
		return false
	}
	for _, r := range segment[len(prefix):] {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}

func assignItemSegments(kind string, items []map[string]any, disk map[string]string, frozen bool) {
	used := map[string]bool{}
	var pending []map[string]any
	for _, item := range items {
		id := stringValue(item, "id")
		if id == "" {
			continue
		}
		current := disk[kind+":"+id]
		keep := current != "" && (frozen || segmentFitsName(current, fileNameForName(stringValue(item, "name"))))
		if keep && !used[strings.ToLower(current)] {
			used[strings.ToLower(current)] = true
			item[filesystemNameField] = current
			continue
		}
		pending = append(pending, item)
	}
	for _, item := range pending {
		base := fileNameForName(stringValue(item, "name"))
		if base == "" {
			base = pathSafeID(stringValue(item, "id"))
		}
		segment := base
		for suffix := 1; used[strings.ToLower(segment)]; suffix++ {
			segment = fmt.Sprintf("%s-%d", base, suffix)
		}
		used[strings.ToLower(segment)] = true
		item[filesystemNameField] = segment
	}
}

func ensureStoreFilesystemNames(workspaces, collections, requests, environments []map[string]any, disk map[string]string, frozen bool) {
	assignItemSegments("workspace", workspaces, disk, frozen)
	for _, group := range groupByString(collections, "workspaceId") {
		assignItemSegments("collection", group, disk, frozen)
	}
	for _, group := range groupByString(requests, "collectionId") {
		assignItemSegments("request", group, disk, frozen)
	}
	for _, group := range groupByString(environments, "workspaceId") {
		assignItemSegments("environment", group, disk, frozen)
	}
}

func diskItemSegments(workspaces, collections, requests, environments []map[string]any) map[string]string {
	segments := map[string]string{}
	for kind, items := range map[string][]map[string]any{"workspace": workspaces, "collection": collections, "request": requests, "environment": environments} {
		for _, item := range items {
			segments[kind+":"+stringValue(item, "id")] = stringValue(item, filesystemNameField)
		}
	}
	return segments
}
