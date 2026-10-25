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

type K6ExportResult struct {
	Script   string            `json:"script"`
	FileName string            `json:"fileName"`
	Warnings []K6ExportWarning `json:"warnings"`
	Error    string            `json:"error,omitempty"`
}
