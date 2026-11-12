package model

type Assertion struct {
	Enabled  bool   `json:"enabled"`
	Target   string `json:"target"`
	Operator string `json:"operator"`
	Value    string `json:"value"`
}

type TestResult struct {
	Name   string `json:"name"`
	Passed bool   `json:"passed"`
	Error  string `json:"error,omitempty"`
}

type ScriptResult struct {
	Tests []TestResult `json:"tests"`
	Logs  []string     `json:"logs,omitempty"`
	Error string       `json:"error,omitempty"`

	SkippedRequest bool `json:"skippedRequest,omitempty"`

	CollectionVariables        map[string]string `json:"collectionVariables,omitempty"`
	CollectionVariablesRemoved []string          `json:"collectionVariablesRemoved,omitempty"`
}
