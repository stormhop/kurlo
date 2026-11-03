package model

type ClaudeConnection struct {
	Path         string          `json:"path"`
	Model        string          `json:"model"`
	DefaultModel string          `json:"defaultModel,omitempty"`
	RateLimit    *CodexRateLimit `json:"rateLimit,omitempty"`
}

type ClaudeStatus struct {
	Installed     bool                `json:"installed"`
	Connected     bool                `json:"connected"`
	Authenticated bool                `json:"authenticated"`
	Path          string              `json:"path"`
	Version       string              `json:"version"`
	Account       string              `json:"account"`
	AuthMethod    string              `json:"authMethod"`
	Model         string              `json:"model"`
	Models        []AiConnectionModel `json:"models"`
	DefaultModel  string              `json:"defaultModel,omitempty"`
	RateLimits    []CodexRateLimit    `json:"rateLimits,omitempty"`
	Error         string              `json:"error,omitempty"`
}
