package model

type MockRoute struct {
	ExampleID     string     `json:"exampleId"`
	ExampleName   string     `json:"exampleName"`
	RequestID     string     `json:"requestId"`
	RequestName   string     `json:"requestName"`
	Method        string     `json:"method"`
	PathTemplate  string     `json:"pathTemplate"`
	Query         []KeyValue `json:"query"`
	StatusCode    int        `json:"statusCode"`
	Status        string     `json:"status"`
	Headers       []KeyValue `json:"headers"`
	Body          string     `json:"body"`
	BodyMediaType string     `json:"bodyMediaType"`
	DelayMs       int        `json:"delayMs"`
}

type MockRequestRef struct {
	RequestID   string      `json:"requestId"`
	RequestName string      `json:"requestName"`
	Method      string      `json:"method"`
	Loaded      bool        `json:"loaded"`
	Routes      []MockRoute `json:"routes"`
}

type MockServerConfig struct {
	Port            int              `json:"port"`
	CollectionID    string           `json:"collectionId"`
	CollectionName  string           `json:"collectionName"`
	Routes          []MockRoute      `json:"routes"`
	Requests        []MockRequestRef `json:"requests"`
	SimulateLatency bool             `json:"simulateLatency"`
}

type MockServerStatus struct {
	Running        bool   `json:"running"`
	Port           int    `json:"port"`
	URL            string `json:"url"`
	CollectionID   string `json:"collectionId"`
	CollectionName string `json:"collectionName"`
	RouteCount     int    `json:"routeCount"`
	Error          string `json:"error,omitempty"`
}

type MockRequestLog struct {
	ID          string `json:"id"`
	Method      string `json:"method"`
	Path        string `json:"path"`
	Query       string `json:"query"`
	Matched     bool   `json:"matched"`
	ExampleID   string `json:"exampleId,omitempty"`
	ExampleName string `json:"exampleName,omitempty"`
	RequestName string `json:"requestName,omitempty"`
	RequestID   string `json:"requestId,omitempty"`
	Note        string `json:"note,omitempty"`
	StatusCode  int    `json:"statusCode"`
	DurationMs  int64  `json:"durationMs"`
	Timestamp   int64  `json:"timestamp"`
}
