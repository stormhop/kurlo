package model

type GrpcRequest struct {
	RequestID string `json:"requestId"`

	Target     string     `json:"target"`
	FullMethod string     `json:"fullMethod"`
	Message    string     `json:"message"`
	Metadata   []KeyValue `json:"metadata"`
	Auth       AuthConfig `json:"auth"`

	UseReflection    bool     `json:"useReflection"`
	ProtoFilePath    string   `json:"protoFilePath"`
	ProtoImportPaths []string `json:"protoImportPaths"`

	UseTLS                   bool   `json:"useTls"`
	EnableSSLVerification    bool   `json:"enableSSLVerification"`
	ServerName               string `json:"serverName"`
	IncludeDefaultValues     bool   `json:"includeDefaultValues"`
	MaxResponseMessageSizeMb int    `json:"maxResponseMessageSizeMb"`
	TimeoutMs                int    `json:"timeoutMs"`

	PreRequestScript        string            `json:"preRequestScript"`
	TestScript              string            `json:"testScript"`
	ScriptEngine            string            `json:"scriptEngine"`
	Name                    string            `json:"name"`
	ScriptTimeoutMs         int               `json:"scriptTimeoutMs"`
	AllowSendRequest        bool              `json:"allowSendRequest"`
	SecretEnvironmentKeys   []string          `json:"secretEnvironmentKeys"`
	SecretEnvironmentValues []string          `json:"secretEnvironmentValues"`
	CollectionVariables     map[string]string `json:"collectionVariables"`
}

type GrpcMessage struct {
	Index     int    `json:"index"`
	Direction string `json:"direction,omitempty"`
	Body      string `json:"body"`
	Size      int    `json:"size"`
	Timestamp int64  `json:"timestamp"`
}

type GrpcResponse struct {
	GrpcCode    string `json:"grpcCode"`
	GrpcMessage string `json:"grpcMessage"`
	Status      string `json:"status"`

	Headers   []KeyValue     `json:"headers"`
	Trailers  []KeyValue     `json:"trailers"`
	Messages  []GrpcMessage  `json:"messages"`
	Body      string         `json:"body"`
	Duration  int64          `json:"duration"`
	Size      int64          `json:"size"`
	Timestamp int64          `json:"timestamp,omitempty"`
	Error     string         `json:"error,omitempty"`
	Method    GrpcMethodInfo `json:"method"`

	PreRequestResult ScriptResult `json:"preRequestResult"`
	TestResult       ScriptResult `json:"testResult"`

	CollectionVariableUpdates  map[string]string `json:"collectionVariableUpdates,omitempty"`
	CollectionVariablesRemoved []string          `json:"collectionVariablesRemoved,omitempty"`
}

type GrpcHeadersEvent struct {
	RequestID string         `json:"requestId"`
	Headers   []KeyValue     `json:"headers"`
	Method    GrpcMethodInfo `json:"method"`
	Duration  int64          `json:"duration"`
	Timestamp int64          `json:"timestamp"`
}

type GrpcMessageEvent struct {
	RequestID string      `json:"requestId"`
	Message   GrpcMessage `json:"message"`
	Size      int64       `json:"size"`
	Duration  int64       `json:"duration"`
	Timestamp int64       `json:"timestamp"`
}

type GrpcTrailersEvent struct {
	RequestID   string     `json:"requestId"`
	GrpcCode    string     `json:"grpcCode"`
	GrpcMessage string     `json:"grpcMessage"`
	Status      string     `json:"status"`
	Trailers    []KeyValue `json:"trailers"`
	Error       string     `json:"error,omitempty"`
	Duration    int64      `json:"duration"`
	Timestamp   int64      `json:"timestamp"`
}

type GrpcDoneEvent struct {
	RequestID string       `json:"requestId"`
	Response  GrpcResponse `json:"response"`
	Timestamp int64        `json:"timestamp"`
}

type GrpcMethodInfo struct {
	FullName        string `json:"fullName"`
	Service         string `json:"service"`
	Name            string `json:"name"`
	RequestType     string `json:"requestType"`
	ResponseType    string `json:"responseType"`
	ExampleMessage  string `json:"exampleMessage"`
	ClientStreaming bool   `json:"clientStreaming"`
	ServerStreaming bool   `json:"serverStreaming"`
}

type GrpcServiceDefinition struct {
	Source   string           `json:"source"`
	Services []string         `json:"services"`
	Methods  []GrpcMethodInfo `json:"methods"`
	Error    string           `json:"error,omitempty"`
}
