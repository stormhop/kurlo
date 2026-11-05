package model

const (
	AgentClientName = "Kurlo agent"

	AgentToolRead     = "read"
	AgentToolRun      = "run"
	AgentToolWrite    = "write"
	AgentToolExternal = "external"

	AgentApprovalAllow     = "allow"
	AgentApprovalAllowChat = "allow_chat"
	AgentApprovalReject    = "reject"

	AgentActivityOK       = "ok"
	AgentActivityError    = "error"
	AgentActivityDeclined = "declined"
)

type AgentFileChange struct {
	Path     string  `json:"path"`
	Before   *string `json:"before"`
	After    *string `json:"after"`
	TooLarge bool    `json:"tooLarge,omitempty"`
	Reverted bool    `json:"reverted,omitempty"`
}

type AgentApproval struct {
	ID        string            `json:"id"`
	ChatID    string            `json:"chatId"`
	TurnID    string            `json:"turnId,omitempty"`
	ToolUseID string            `json:"toolUseId,omitempty"`
	Tool      string            `json:"tool"`
	Kind      string            `json:"kind"`
	Arguments string            `json:"arguments"`
	Reason    string            `json:"reason"`
	Changes   []AgentFileChange `json:"changes"`
}

type AgentApprovalClosed struct {
	ID       string `json:"id"`
	ChatID   string `json:"chatId"`
	Decision string `json:"decision"`
}

type AgentChatSummary struct {
	ArchivedAt  int64  `json:"archivedAt,omitempty"`
	WorkspaceID string `json:"workspaceId"`
	Driver      string `json:"driver,omitempty"`
	ID          string `json:"id"`
	Title       string `json:"title"`
	CreatedAt   int64  `json:"createdAt"`
	UpdatedAt   int64  `json:"updatedAt"`
}

type AgentChat struct {
	ProjectRoot      string      `json:"projectRoot,omitempty"`
	ArchivedAt       int64       `json:"archivedAt,omitempty"`
	MessageOffset    int         `json:"messageOffset,omitempty"`
	MessageCount     int         `json:"messageCount,omitempty"`
	WorkspaceID      string      `json:"workspaceId"`
	ContextTokens    int64       `json:"contextTokens,omitempty"`
	ContextWindow    int64       `json:"contextWindow,omitempty"`
	Effort           string      `json:"effort,omitempty"`
	Driver           string      `json:"driver,omitempty"`
	ExternalThreadID string      `json:"externalThreadId,omitempty"`
	ID               string      `json:"id"`
	Title            string      `json:"title"`
	Workspace        string      `json:"workspace"`
	CreatedAt        int64       `json:"createdAt"`
	UpdatedAt        int64       `json:"updatedAt"`
	Collection       string      `json:"collection"`
	Environment      string      `json:"environment"`
	ConnectionID     string      `json:"connectionId"`
	Model            string      `json:"model"`
	Messages         []AiMessage `json:"messages"`
	Usage            AiUsage     `json:"usage"`
	AllowedTools     []string    `json:"allowedTools"`
	OwnBranch        bool        `json:"ownBranch,omitempty"`
	Branch           string      `json:"branch,omitempty"`
}

type AgentAttachment struct {
	Name      string `json:"name"`
	ID        string `json:"id,omitempty"`
	MediaType string `json:"mediaType,omitempty"`
	Preview   string `json:"preview,omitempty"`
}

type AgentSendInput struct {
	ProjectRoot  *string  `json:"projectRoot,omitempty"`
	Attachments  []string `json:"attachments,omitempty"`
	WorkspaceID  string   `json:"workspaceId"`
	Effort       string   `json:"effort,omitempty"`
	Driver       string   `json:"driver,omitempty"`
	ChatID       string   `json:"chatId"`
	TurnID       string   `json:"turnId"`
	Text         string   `json:"text"`
	Collection   string   `json:"collection"`
	Environment  string   `json:"environment"`
	ConnectionID string   `json:"connectionId"`
	Model        string   `json:"model"`
	OwnBranch    bool     `json:"ownBranch,omitempty"`
}

type AgentTurn struct {
	Chat     AgentChat   `json:"chat"`
	Messages []AiMessage `json:"messages"`
	Steps    []AiStep    `json:"steps"`
	Text     string      `json:"text"`
	Usage    AiUsage     `json:"usage"`
	HasUsage bool        `json:"hasUsage"`
	Warnings []string    `json:"warnings"`
	Error    string      `json:"error,omitempty"`
}

type AgentActivitySummary struct {
	ID            string   `json:"id"`
	Time          int64    `json:"time"`
	Client        string   `json:"client"`
	ChatID        string   `json:"chatId,omitempty"`
	Tool          string   `json:"tool"`
	Status        string   `json:"status"`
	Error         string   `json:"error,omitempty"`
	Files         []string `json:"files"`
	Reverted      bool     `json:"reverted"`
	Workspace     string   `json:"workspace"`
	WorkspaceID   string   `json:"workspaceId,omitempty"`
	Here          bool     `json:"here,omitempty"`
	WorkspaceName string   `json:"workspaceName,omitempty"`
	Commit        string   `json:"commit,omitempty"`
	Branch        string   `json:"branch,omitempty"`
}

type AgentActivityEntry struct {
	AgentActivitySummary
	Arguments string            `json:"arguments"`
	Result    string            `json:"result"`
	Changes   []AgentFileChange `json:"changes"`
}

type AgentActivityFilter struct {
	WorkspaceID   string `json:"workspaceId"`
	AllWorkspaces bool   `json:"allWorkspaces"`
	Client        string `json:"client"`
	Tool          string `json:"tool"`
	Since         int64  `json:"since"`
	Until         int64  `json:"until"`
	Limit         int    `json:"limit"`
}

type AgentActivityList struct {
	Entries []AgentActivitySummary `json:"entries"`
	Enabled bool                   `json:"enabled"`
	Error   string                 `json:"error,omitempty"`
}

type AgentResult struct {
	Ok    bool   `json:"ok"`
	Error string `json:"error,omitempty"`
}
