package loadtest

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
)

func schemaEnum(t *testing.T, definitions map[string]any, path ...string) []string {
	t.Helper()
	node := definitions
	for _, key := range path {
		next, ok := node[key].(map[string]any)
		if !ok {
			t.Fatalf("schema has no %s", strings.Join(path, "."))
		}
		node = next
	}
	raw, ok := node["enum"].([]any)
	if !ok {
		t.Fatalf("schema %s has no enum", strings.Join(path, "."))
	}
	values := make([]string, 0, len(raw))
	for _, value := range raw {
		values = append(values, value.(string))
	}
	sort.Strings(values)
	return values
}

func sortedKeys[V any](m map[string]V) []string {
	keys := make([]string, 0, len(m))
	for key := range m {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

func TestSchemaEnumsMatchTheValidator(t *testing.T) {
	data, err := os.ReadFile(filepath.Join("..", "..", "..", "..", "schemas", "kurlo-workspace-yaml-v1.schema.json"))
	if err != nil {
		t.Fatal(err)
	}
	var schema map[string]any
	if err := json.Unmarshal(data, &schema); err != nil {
		t.Fatal(err)
	}
	definitions := schema["definitions"].(map[string]any)
	threshold := []string{"loadTest", "properties", "thresholds", "items", "properties"}

	stats := map[string]bool{}
	for _, metricStats := range thresholdStats {
		for stat := range metricStats {
			stats[stat] = true
		}
	}
	for _, pair := range []struct {
		name string
		got  []string
		want []string
	}{
		{"metric", schemaEnum(t, definitions, append(threshold, "metric")...), sortedKeys(thresholdStats)},
		{"stat", schemaEnum(t, definitions, append(threshold, "stat")...), sortedKeys(stats)},
		{"op", schemaEnum(t, definitions, append(threshold, "op")...), sortedKeys(thresholdOps)},
	} {
		if strings.Join(pair.got, ",") != strings.Join(pair.want, ",") {
			t.Errorf("schema threshold %s = %v, validator accepts %v", pair.name, pair.got, pair.want)
		}
	}

	for _, executorType := range schemaEnum(t, definitions, "loadExecutor", "properties", "type") {
		test := validTest()
		test.Scenarios[0].Executor.Type = executorType
		for _, problem := range Validate(test, testRequests()) {
			if strings.Contains(problem, "Unknown load model") {
				t.Errorf("schema allows executor %q but the validator does not", executorType)
			}
		}
	}
}
