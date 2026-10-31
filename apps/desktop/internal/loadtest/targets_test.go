package loadtest

import (
	"strings"
	"testing"

	"github.com/stormhop/kurlo/apps/desktop/internal/model"
)

func TestValidateRunTargets(t *testing.T) {
	for _, target := range []string{"", "стресс", "%D0%B0%D0%B2%D0%B0", "/work", "localhost:18080/work", "ftp://localhost/work", "http://"} {
		plan := Plan{Test: model.LoadTest{Scenarios: []model.LoadScenario{{Steps: []model.LoadStep{{RequestID: "r"}}}}}, Requests: map[string]Request{"r": {URL: target}}}
		if err := ValidateRunTargets(plan); err == nil || !strings.Contains(err.Error(), "Step 1") {
			t.Errorf("target %q: %v", target, err)
		}
	}
	for _, target := range []string{"http://127.0.0.1:18080/work", "https://example.test/work", "{{baseUrl}}/work", "https://{{host}}/work"} {
		plan := Plan{Test: model.LoadTest{Scenarios: []model.LoadScenario{{Steps: []model.LoadStep{{RequestID: "r"}}}}}, Requests: map[string]Request{"r": {URL: target}}}
		if err := ValidateRunTargets(plan); err != nil {
			t.Errorf("target %q: %v", target, err)
		}
	}
	plan := Plan{Test: model.LoadTest{Scenarios: []model.LoadScenario{{Steps: []model.LoadStep{{RequestID: "r"}}}}}, Requests: map[string]Request{"r": {URL: "{{baseUrl}}/work"}}, Variables: []Variable{{Name: "baseUrl", Value: "invalid-secret", Secret: true}}}
	if err := ValidateRunTargets(plan); err == nil || strings.Contains(err.Error(), "invalid-secret") {
		t.Fatalf("invalid secret URL: %v", err)
	}
	plan.Variables[0].Value = "http://127.0.0.1:18080"
	if err := ValidateRunTargets(plan); err != nil {
		t.Fatal(err)
	}
}
