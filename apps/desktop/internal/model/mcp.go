package model

const McpDefaultProtocolVersion = "2026-07-28"

type McpTool struct {
	Name         string `json:"name"`
	Title        string `json:"title,omitempty"`
	Description  string `json:"description,omitempty"`
	InputSchema  string `json:"inputSchema,omitempty"`
	OutputSchema string `json:"outputSchema,omitempty"`
	Annotations  string `json:"annotations,omitempty"`
	Rejected     string `json:"rejected,omitempty"`
}

type McpResource struct {
	URI         string `json:"uri"`
	Name        string `json:"name,omitempty"`
	Title       string `json:"title,omitempty"`
	Description string `json:"description,omitempty"`
	MimeType    string `json:"mimeType,omitempty"`
}

type McpPrompt struct {
	Name        string `json:"name"`
	Title       string `json:"title,omitempty"`
	Description string `json:"description,omitempty"`
	Arguments   string `json:"arguments,omitempty"`
}

type McpContent struct {
	Type        string `json:"type"`
	Text        string `json:"text,omitempty"`
	Data        string `json:"data,omitempty"`
	MimeType    string `json:"mimeType,omitempty"`
	URI         string `json:"uri,omitempty"`
	Name        string `json:"name,omitempty"`
	Description string `json:"description,omitempty"`
}

type McpNotification struct {
	Method string `json:"method"`
	Params string `json:"params,omitempty"`
}

type McpResponse struct {
	HTTP HttpResponse `json:"http"`

	ServerName        string   `json:"serverName,omitempty"`
	ServerVersion     string   `json:"serverVersion,omitempty"`
	Instructions      string   `json:"instructions,omitempty"`
	ProtocolVersion   string   `json:"protocolVersion,omitempty"`
	SupportedVersions []string `json:"supportedVersions"`
	Capabilities      []string `json:"capabilities"`

	ResultType        string        `json:"resultType,omitempty"`
	Result            string        `json:"result,omitempty"`
	Content           []McpContent  `json:"content"`
	StructuredContent string        `json:"structuredContent,omitempty"`
	IsError           bool          `json:"isError,omitempty"`
	Tools             []McpTool     `json:"tools"`
	Resources         []McpResource `json:"resources"`
	Prompts           []McpPrompt   `json:"prompts"`
	NextCursor        string        `json:"nextCursor,omitempty"`
	TTLMs             int64         `json:"ttlMs,omitempty"`
	CacheScope        string        `json:"cacheScope,omitempty"`

	InputRequests string `json:"inputRequests,omitempty"`
	RequestState  string `json:"requestState,omitempty"`

	Notifications []McpNotification `json:"notifications"`

	RPCErrorCode    int    `json:"rpcErrorCode,omitempty"`
	RPCErrorMessage string `json:"rpcErrorMessage,omitempty"`
	RPCErrorData    string `json:"rpcErrorData,omitempty"`

	Warnings []string `json:"warnings"`
	Error    string   `json:"error,omitempty"`
}

func (r McpResponse) withSlices() McpResponse {
	if r.SupportedVersions == nil {
		r.SupportedVersions = []string{}
	}
	if r.Capabilities == nil {
		r.Capabilities = []string{}
	}
	if r.Content == nil {
		r.Content = []McpContent{}
	}
	if r.Tools == nil {
		r.Tools = []McpTool{}
	}
	if r.Resources == nil {
		r.Resources = []McpResource{}
	}
	if r.Prompts == nil {
		r.Prompts = []McpPrompt{}
	}
	if r.Notifications == nil {
		r.Notifications = []McpNotification{}
	}
	if r.Warnings == nil {
		r.Warnings = []string{}
	}
	return r
}

func NormalizeMcpResponse(r McpResponse) McpResponse {
	r = r.withSlices()
	r.HTTP.Headers = normalizeKeyValues(r.HTTP.Headers)
	return r
}

func normalizeKeyValues(rows []KeyValue) []KeyValue {
	if rows == nil {
		return []KeyValue{}
	}
	return rows
}
