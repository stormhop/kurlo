package api

import (
	"encoding/csv"
	"encoding/json"
	"fmt"
	"os"
	"strconv"
	"strings"
)

func loadDataFile(path string) ([]map[string]string, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("data file: %w", err)
	}
	return parseCLIData(string(data), path)
}

func parseCLIData(data, path string) ([]map[string]string, error) {
	trimmed := strings.TrimSpace(data)
	if trimmed == "" {
		return nil, fmt.Errorf("data file is empty")
	}

	lower := strings.ToLower(path)
	isJSON := strings.HasSuffix(lower, ".json") || strings.HasPrefix(trimmed, "[") || strings.HasPrefix(trimmed, "{")
	if isJSON {
		return parseJSONDataRows(trimmed)
	}
	return parseCSVDataRows(data)
}

func parseJSONDataRows(text string) ([]map[string]string, error) {
	var payload any
	if err := json.Unmarshal([]byte(text), &payload); err != nil {
		return nil, fmt.Errorf("data file is not valid JSON: %w", err)
	}
	var rawRows []any
	switch value := payload.(type) {
	case []any:
		rawRows = value
	case map[string]any:
		if inner, ok := value["data"].([]any); ok {
			rawRows = inner
		} else if inner, ok := value["rows"].([]any); ok {
			rawRows = inner
		} else {
			rawRows = []any{value}
		}
	default:
		return nil, fmt.Errorf("data file must be a JSON array or object")
	}

	rows := make([]map[string]string, 0, len(rawRows))
	for index, raw := range rawRows {
		obj, ok := raw.(map[string]any)
		if !ok {
			return nil, fmt.Errorf("data row %d must be an object", index+1)
		}
		row := make(map[string]string, len(obj))
		for key, cell := range obj {
			key = strings.TrimSpace(key)
			if key != "" {
				row[key] = jsonCellToString(cell)
			}
		}
		rows = append(rows, row)
	}
	if len(rows) == 0 {
		return nil, fmt.Errorf("data file has no rows")
	}
	return rows, nil
}

func jsonCellToString(cell any) string {
	switch value := cell.(type) {
	case nil:
		return ""
	case string:
		return value
	case bool:
		return strconv.FormatBool(value)
	case float64:
		if value == float64(int64(value)) {
			return strconv.FormatInt(int64(value), 10)
		}
		return strconv.FormatFloat(value, 'f', -1, 64)
	default:
		encoded, err := json.Marshal(value)
		if err != nil {
			return ""
		}
		return string(encoded)
	}
}

func parseCSVDataRows(text string) ([]map[string]string, error) {
	reader := csv.NewReader(strings.NewReader(text))
	reader.TrimLeadingSpace = true
	reader.FieldsPerRecord = -1
	records, err := reader.ReadAll()
	if err != nil {
		return nil, fmt.Errorf("data file is not valid CSV: %w", err)
	}
	if len(records) < 2 {
		return nil, fmt.Errorf("CSV data file needs a header row and at least one data row")
	}
	header := records[0]
	rows := make([]map[string]string, 0, len(records)-1)
	for _, record := range records[1:] {
		if len(record) == 1 && strings.TrimSpace(record[0]) == "" {
			continue
		}
		row := make(map[string]string, len(header))
		for i, key := range header {
			key = strings.TrimSpace(key)
			if key == "" || i >= len(record) {
				continue
			}
			row[key] = record[i]
		}
		rows = append(rows, row)
	}
	if len(rows) == 0 {
		return nil, fmt.Errorf("CSV data file has no data rows")
	}
	return rows, nil
}
