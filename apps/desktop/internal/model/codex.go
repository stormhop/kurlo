package model

type CodexConnection struct {
	Path  string `json:"path"`
	Model string `json:"model"`
}

type CodexStatus struct {
	RateLimits    []CodexRateLimit    `json:"rateLimits,omitempty"`
	Installed     bool                `json:"installed"`
	Connected     bool                `json:"connected"`
	Authenticated bool                `json:"authenticated"`
	Path          string              `json:"path"`
	Version       string              `json:"version"`
	Account       string              `json:"account"`
	AuthType      string              `json:"authType"`
	Model         string              `json:"model"`
	Models        []AiConnectionModel `json:"models"`
	AuthURL       string              `json:"authUrl"`
	Waiting       bool                `json:"waiting"`
	Error         string              `json:"error,omitempty"`
}

type CodexRateWindow struct {
	UsedPercent   int   `json:"usedPercent"`
	WindowMinutes int64 `json:"windowDurationMins,omitempty"`
	ResetsAt      int64 `json:"resetsAt,omitempty"`
}

type CodexRateLimit struct {
	ID        string           `json:"limitId,omitempty"`
	Name      string           `json:"limitName,omitempty"`
	Primary   *CodexRateWindow `json:"primary,omitempty"`
	Secondary *CodexRateWindow `json:"secondary,omitempty"`
}

type AgentContext struct {
	ChatID string `json:"chatId"`
	TurnID string `json:"turnId"`
	Tokens int64  `json:"tokens"`
	Window int64  `json:"window"`
}
