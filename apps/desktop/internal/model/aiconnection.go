package model

const (
	AiConnectionOpenRouter = "openrouter"
	AiConnectionAnthropic  = "anthropic"
	AiConnectionOpenAI     = "openai"
	AiConnectionCompatible = "compatible"
	AiConnectionLocal      = "local"

	OpenRouterConnectIdle      = "idle"
	OpenRouterConnectWaiting   = "waiting"
	OpenRouterConnectConnected = "connected"
	OpenRouterConnectFailed    = "failed"
	OpenRouterConnectCancelled = "cancelled"
)

type AiConnection struct {
	ID       string `json:"id"`
	Kind     string `json:"kind"`
	Label    string `json:"label"`
	BaseURL  string `json:"baseUrl"`
	Model    string `json:"model"`
	HasKey   bool   `json:"hasKey"`
	KeyHint  string `json:"keyHint"`
	Default  bool   `json:"default"`
	Provider string `json:"provider"`
}

type AiConnectionsState struct {
	Connections []AiConnection `json:"connections"`
	Error       string         `json:"error,omitempty"`
}

type AiConnectionInput struct {
	ID      string `json:"id"`
	Kind    string `json:"kind"`
	Label   string `json:"label"`
	BaseURL string `json:"baseUrl"`
	Key     string `json:"key"`
	Model   string `json:"model"`
}

type AiConnectionModel struct {
	ID          string `json:"id"`
	Name        string `json:"name"`
	Recommended bool   `json:"recommended"`
	WeakTools   bool   `json:"weakTools"`
}

type AiConnectionTestResult struct {
	OK     bool                `json:"ok"`
	Models []AiConnectionModel `json:"models"`
	Error  string              `json:"error,omitempty"`
}

type AiLocalServer struct {
	Name    string              `json:"name"`
	BaseURL string              `json:"baseUrl"`
	Models  []AiConnectionModel `json:"models"`
}

type AiLocalDiscovery struct {
	Servers []AiLocalServer `json:"servers"`
}

type OpenRouterConnectState struct {
	Status     string        `json:"status"`
	AuthURL    string        `json:"authUrl"`
	Error      string        `json:"error,omitempty"`
	Connection *AiConnection `json:"connection,omitempty"`
}
