package model

type LoadTest struct {
	ID             string          `json:"id"`
	Name           string          `json:"name"`
	FilesystemName string          `json:"filesystemName,omitempty"`
	Scenarios      []LoadScenario  `json:"scenarios"`
	Thresholds     []LoadThreshold `json:"thresholds,omitempty"`
	Data           *LoadDataSource `json:"data,omitempty"`
	Settings       LoadSettings    `json:"settings"`
}

type LoadScenario struct {
	ID       string       `json:"id"`
	Name     string       `json:"name"`
	Executor LoadExecutor `json:"executor"`
	Steps    []LoadStep   `json:"steps"`
}

type LoadExecutor struct {
	Type            string      `json:"type"`
	VUs             int         `json:"vus,omitempty"`
	DurationMs      int         `json:"durationMs,omitempty"`
	Stages          []LoadStage `json:"stages,omitempty"`
	Rate            int         `json:"rate,omitempty"`
	TimeUnitMs      int         `json:"timeUnitMs,omitempty"`
	PreAllocatedVUs int         `json:"preAllocatedVUs,omitempty"`
	MaxVUs          int         `json:"maxVUs,omitempty"`
}

type LoadStage struct {
	DurationMs int `json:"durationMs"`
	Target     int `json:"target"`
}

type LoadStep struct {
	ID            string        `json:"id"`
	RequestID     string        `json:"requestId"`
	Name          string        `json:"name,omitempty"`
	Once          bool          `json:"once,omitempty"`
	Extract       []LoadExtract `json:"extract,omitempty"`
	Checks        []LoadCheck   `json:"checks,omitempty"`
	ThinkTimeMs   int           `json:"thinkTimeMs,omitempty"`
	ThinkJitterMs int           `json:"thinkJitterMs,omitempty"`
}

type LoadExtract struct {
	Var  string `json:"var"`
	From string `json:"from"`
	Path string `json:"path"`
}

type LoadCheck struct {
	Type  string `json:"type"`
	Path  string `json:"path,omitempty"`
	Value string `json:"value,omitempty"`
}

type LoadThreshold struct {
	Metric      string  `json:"metric"`
	Stat        string  `json:"stat"`
	Op          string  `json:"op"`
	Value       float64 `json:"value"`
	Step        string  `json:"step,omitempty"`
	AbortOnFail bool    `json:"abortOnFail,omitempty"`
}

type LoadDataSource struct {
	Path string `json:"path"`
	Mode string `json:"mode"`
}

type LoadSettings struct {
	Environment string `json:"environment,omitempty"`
	Insecure    bool   `json:"insecure,omitempty"`
	TimeoutMs   int    `json:"timeoutMs,omitempty"`
}

type LoadTestRequest struct {
	ID          string `json:"id"`
	RequestType string `json:"requestType"`
}

type K6ExportWarning struct {
	Level   string `json:"level"`
	Step    int    `json:"step,omitempty"`
	Message string `json:"message"`
}

type K6ExportStep struct {
	StepID string `json:"stepId"`
	Tag    string `json:"tag"`
}

type K6ExportResult struct {
	Script   string            `json:"script"`
	FileName string            `json:"fileName"`
	Warnings []K6ExportWarning `json:"warnings"`
	Steps    []K6ExportStep    `json:"steps"`
	Error    string            `json:"error,omitempty"`
}

type K6Info struct {
	Found   bool   `json:"found"`
	Path    string `json:"path"`
	Version string `json:"version"`
	Error   string `json:"error,omitempty"`
}

type LoadRunProgress struct {
	ElapsedMs   int64 `json:"elapsedMs"`
	VUs         int   `json:"vus"`
	MaxVUs      int   `json:"maxVUs"`
	Iterations  int64 `json:"iterations"`
	Interrupted int64 `json:"interrupted"`
}

type LoadRunState struct {
	Running      bool            `json:"running"`
	Stopping     bool            `json:"stopping"`
	LoadTestID   string          `json:"loadTestId"`
	CollectionID string          `json:"collectionId"`
	StartedAt    int64           `json:"startedAt"`
	PlannedMs    int64           `json:"plannedMs"`
	DashboardURL string          `json:"dashboardUrl"`
	K6Version    string          `json:"k6Version"`
	Progress     LoadRunProgress `json:"progress"`
	Error        string          `json:"error,omitempty"`
}

type LoadRunThreshold struct {
	Metric     string  `json:"metric"`
	StepID     string  `json:"stepId,omitempty"`
	Expression string  `json:"expression"`
	Ok         bool    `json:"ok"`
	Actual     float64 `json:"actual"`
	HasActual  bool    `json:"hasActual"`
}

type LoadRunStep struct {
	StepID       string  `json:"stepId"`
	Tag          string  `json:"tag"`
	Requests     int64   `json:"requests"`
	Med          float64 `json:"med"`
	P95          float64 `json:"p95"`
	P99          float64 `json:"p99"`
	FailedRate   float64 `json:"failedRate"`
	ChecksRate   float64 `json:"checksRate"`
	ChecksPassed int64   `json:"checksPassed"`
	ChecksFailed int64   `json:"checksFailed"`
}

type LoadRunTotals struct {
	Requests     int64   `json:"requests"`
	RPS          float64 `json:"rps"`
	Avg          float64 `json:"avg"`
	Med          float64 `json:"med"`
	P95          float64 `json:"p95"`
	P99          float64 `json:"p99"`
	Max          float64 `json:"max"`
	FailedRate   float64 `json:"failedRate"`
	FailedCount  int64   `json:"failedCount"`
	ChecksPassed int64   `json:"checksPassed"`
	ChecksFailed int64   `json:"checksFailed"`
	Iterations   int64   `json:"iterations"`
	Interrupted  int64   `json:"interrupted"`
	MaxVUs       int     `json:"maxVUs"`
}

type LoadRunResult struct {
	LoadTestID   string             `json:"loadTestId"`
	CollectionID string             `json:"collectionId"`
	LoadTestName string             `json:"loadTestName"`
	Environment  string             `json:"environment"`
	K6Version    string             `json:"k6Version"`
	Status       string             `json:"status"`
	ExitCode     int                `json:"exitCode"`
	StartedAt    int64              `json:"startedAt"`
	FinishedAt   int64              `json:"finishedAt"`
	Error        string             `json:"error,omitempty"`
	Thresholds   []LoadRunThreshold `json:"thresholds"`
	Totals       LoadRunTotals      `json:"totals"`
	Steps        []LoadRunStep      `json:"steps"`
	HasReport    bool               `json:"hasReport"`
	HasSummary   bool               `json:"hasSummary"`
}
