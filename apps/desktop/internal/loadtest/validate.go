package loadtest

import (
	"fmt"
	"path"
	"regexp"
	"strconv"
	"strings"

	"github.com/stormhop/kurlo/apps/desktop/internal/model"
)

var variableName = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)

var durationStats = map[string]bool{"avg": true, "min": true, "med": true, "max": true, "p(90)": true, "p(95)": true, "p(99)": true}

var thresholdStats = map[string]map[string]bool{
	"http_req_duration": durationStats,
	"http_req_failed":   {"rate": true},
	"checks":            {"rate": true},
}

var thresholdOps = map[string]bool{"<": true, "<=": true, ">": true, ">=": true}

func Validate(test model.LoadTest, requests []model.LoadTestRequest) []string {
	v := validator{requestTypes: map[string]string{}}
	for _, request := range requests {
		v.requestTypes[request.ID] = request.RequestType
	}
	if strings.TrimSpace(test.Name) == "" {
		v.add("The load test needs a name.")
	}
	switch len(test.Scenarios) {
	case 0:
		v.add("The load test needs a flow of steps.")
	case 1:
		v.scenario(test.Scenarios[0])
	default:
		v.add("A load test runs one flow. Remove the extra flows.")
	}
	for index, threshold := range test.Thresholds {
		v.threshold(index+1, threshold)
	}
	if test.Data != nil {
		v.data(*test.Data)
	}
	if test.Settings.TimeoutMs < 0 {
		v.add("The request timeout cannot be negative.")
	}
	return v.problems
}

type validator struct {
	requestTypes map[string]string
	stepIDs      map[string]bool
	problems     []string
}

func (v *validator) add(format string, args ...any) {
	v.problems = append(v.problems, fmt.Sprintf(format, args...))
}

func (v *validator) scenario(scenario model.LoadScenario) {
	v.executor(scenario.Executor)
	if len(scenario.Steps) == 0 {
		v.add("Add at least one request to the flow.")
	}
	v.stepIDs = map[string]bool{}
	saved := map[string]int{}
	for index, step := range scenario.Steps {
		number := index + 1
		if strings.TrimSpace(step.ID) == "" {
			v.add("Step %d has no id.", number)
		} else if v.stepIDs[step.ID] {
			v.add("Step %d has the same id as an earlier step.", number)
		} else {
			v.stepIDs[step.ID] = true
		}
		v.stepRequest(number, step.RequestID)
		for _, extract := range step.Extract {
			v.extract(number, extract)
			if variableName.MatchString(extract.Var) {
				if earlier, exists := saved[extract.Var]; exists {
					v.add("Step %d saves %s, which step %d already saves.", number, extract.Var, earlier)
				} else {
					saved[extract.Var] = number
				}
			}
		}
		for _, check := range step.Checks {
			v.check(number, check)
		}
		if step.ThinkTimeMs < 0 || step.ThinkJitterMs < 0 {
			v.add("Step %d: the wait after the step cannot be negative.", number)
		}
	}
}

func (v *validator) stepRequest(number int, requestID string) {
	if strings.TrimSpace(requestID) == "" {
		v.add("Step %d has no request.", number)
		return
	}
	requestType, exists := v.requestTypes[requestID]
	if !exists {
		v.add("Step %d uses a request that is not in this collection.", number)
		return
	}
	switch requestType {
	case "", "http", "graphql":
	default:
		v.add("Step %d uses a %s request. Load tests run HTTP and GraphQL requests only.", number, requestType)
	}
}

func (v *validator) executor(executor model.LoadExecutor) {
	switch executor.Type {
	case "constant-vus":
		if executor.VUs <= 0 {
			v.add("Set the number of virtual users.")
		}
		if executor.DurationMs <= 0 {
			v.add("Set how long the test runs.")
		}
	case "ramping-vus":
		v.stages(executor.Stages)
	case "constant-arrival-rate":
		if executor.Rate <= 0 {
			v.add("Set how many iterations start per second.")
		}
		if executor.DurationMs <= 0 {
			v.add("Set how long the test runs.")
		}
		v.arrivalPool(executor)
	case "ramping-arrival-rate":
		v.stages(executor.Stages)
		v.arrivalPool(executor)
	default:
		v.add("Unknown load model %q.", executor.Type)
	}
	if executor.TimeUnitMs < 0 {
		v.add("The rate time unit cannot be negative.")
	}
}

func (v *validator) stages(stages []model.LoadStage) {
	if len(stages) == 0 {
		v.add("Add at least one stage.")
	}
	for index, stage := range stages {
		if stage.DurationMs <= 0 {
			v.add("Stage %d needs a duration.", index+1)
		}
		if stage.Target < 0 {
			v.add("Stage %d: the target cannot be negative.", index+1)
		}
	}
}

func (v *validator) arrivalPool(executor model.LoadExecutor) {
	if executor.PreAllocatedVUs <= 0 {
		v.add("Set how many virtual users to prepare.")
	}
	if executor.MaxVUs != 0 && executor.MaxVUs < executor.PreAllocatedVUs {
		v.add("The virtual user limit is lower than the number prepared.")
	}
}

func (v *validator) extract(number int, extract model.LoadExtract) {
	if !variableName.MatchString(extract.Var) {
		v.add("Step %d: %q is not a valid variable name. Use letters, digits and _, not starting with a digit.", number, extract.Var)
	}
	switch extract.From {
	case "json":
		if !strings.HasPrefix(strings.TrimSpace(extract.Path), "$") {
			v.add("Step %d: the JSON path for %s must start with $.", number, extract.Var)
		}
	case "header":
		if strings.TrimSpace(extract.Path) == "" {
			v.add("Step %d: name the header to save as %s.", number, extract.Var)
		}
	case "regex":
		pattern, err := regexp.Compile(extract.Path)
		if err != nil {
			v.add("Step %d: the pattern for %s is not a valid regular expression.", number, extract.Var)
		} else if pattern.NumSubexp() != 1 {
			v.add("Step %d: the pattern for %s needs exactly one ( ) group.", number, extract.Var)
		}
	default:
		v.add("Step %d: unknown source %q for %s.", number, extract.From, extract.Var)
	}
}

func (v *validator) check(number int, check model.LoadCheck) {
	switch check.Type {
	case "status":
		code, err := strconv.Atoi(strings.TrimSpace(check.Value))
		if err != nil || code < 100 || code > 599 {
			v.add("Step %d: the expected status must be a number from 100 to 599.", number)
		}
	case "jsonExists":
		if !strings.HasPrefix(strings.TrimSpace(check.Path), "$") {
			v.add("Step %d: the JSON path to check must start with $.", number)
		}
	case "bodyContains":
		if check.Value == "" {
			v.add("Step %d: enter the text the body must contain.", number)
		}
	default:
		v.add("Step %d: unknown check %q.", number, check.Type)
	}
}

func (v *validator) threshold(number int, threshold model.LoadThreshold) {
	stats, known := thresholdStats[threshold.Metric]
	if !known {
		v.add("Threshold %d: unknown metric %q.", number, threshold.Metric)
		return
	}
	if !stats[threshold.Stat] {
		v.add("Threshold %d: %q does not apply to %s.", number, threshold.Stat, threshold.Metric)
	}
	if !thresholdOps[threshold.Op] {
		v.add("Threshold %d: unknown comparison %q.", number, threshold.Op)
	}
	if threshold.Value < 0 || (threshold.Stat == "rate" && threshold.Value > 1) {
		v.add("Threshold %d: the limit is out of range.", number)
	}
	if threshold.Step != "" && !v.stepIDs[threshold.Step] {
		v.add("Threshold %d applies to a step that is not in the flow.", number)
	}
}

func (v *validator) data(data model.LoadDataSource) {
	clean := path.Clean(strings.ReplaceAll(strings.TrimSpace(data.Path), "\\", "/"))
	switch {
	case data.Path == "":
		v.add("Choose a test data file.")
	case path.IsAbs(clean) || strings.Contains(clean, ":") || clean == ".." || strings.HasPrefix(clean, "../"):
		v.add("The test data file must be inside the workspace.")
	default:
		switch strings.ToLower(path.Ext(clean)) {
		case ".csv", ".json":
		default:
			v.add("Test data must be a CSV or JSON file.")
		}
	}
	switch data.Mode {
	case "per-vu", "per-iteration", "random":
	default:
		v.add("Unknown test data mode %q.", data.Mode)
	}
}
