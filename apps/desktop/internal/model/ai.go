package model

const (
	AiProviderOpenAI    = "openai"
	AiProviderAnthropic = "anthropic"

	AiBlockText       = "text"
	AiBlockThinking   = "thinking"
	AiBlockRedacted   = "redacted_thinking"
	AiBlockToolUse    = "tool_use"
	AiBlockToolResult = "tool_result"

	AiStopEndTurn       = "end_turn"
	AiStopToolUse       = "tool_use"
	AiStopMaxTokens     = "max_tokens"
	AiStopStopSequence  = "stop_sequence"
	AiStopRefusal       = "refusal"
	AiStopContentFilter = "content_filter"
	AiStopPauseTurn     = "pause_turn"

	AiDefaultMaxSteps = 8
)

type AiSettings struct {
	Temperature    *float64 `json:"temperature,omitempty"`
	TopP           *float64 `json:"topP,omitempty"`
	MaxTokens      int      `json:"maxTokens,omitempty"`
	Stream         bool     `json:"stream"`
	Thinking       string   `json:"thinking,omitempty"`
	IdleTimeoutSec int      `json:"idleTimeoutSec,omitempty"`
}

type AiToolServer struct {
	Name    string      `json:"name"`
	Request HttpRequest `json:"request"`
}

type AiBlock struct {
	Type      string `json:"type"`
	Text      string `json:"text,omitempty"`
	ID        string `json:"id,omitempty"`
	Name      string `json:"name,omitempty"`
	Input     string `json:"input,omitempty"`
	Server    string `json:"server,omitempty"`
	IsError   bool   `json:"isError,omitempty"`
	Signature string `json:"signature,omitempty"`
	Data      string `json:"data,omitempty"`
}

type AiMessage struct {
	Role   string    `json:"role"`
	Blocks []AiBlock `json:"blocks"`
}

type AiRequest struct {
	HTTP        HttpRequest    `json:"http"`
	Provider    string         `json:"provider"`
	Model       string         `json:"model"`
	System      string         `json:"system"`
	Messages    []AiMessage    `json:"messages"`
	Settings    AiSettings     `json:"settings"`
	ToolServers []AiToolServer `json:"toolServers"`
	MaxSteps    int            `json:"maxSteps"`
}

type AiUsage struct {
	Input      int `json:"input"`
	Output     int `json:"output"`
	CacheRead  int `json:"cacheRead"`
	CacheWrite int `json:"cacheWrite"`
	Reasoning  int `json:"reasoning"`
}

func (u *AiUsage) Add(other AiUsage) {
	u.Input += other.Input
	u.Output += other.Output
	u.CacheRead += other.CacheRead
	u.CacheWrite += other.CacheWrite
	u.Reasoning += other.Reasoning
}

type AiStep struct {
	Index         int          `json:"index"`
	Blocks        []AiBlock    `json:"blocks"`
	ToolResults   []AiBlock    `json:"toolResults"`
	StopReason    string       `json:"stopReason"`
	RawStopReason string       `json:"rawStopReason"`
	Model         string       `json:"model"`
	Usage         AiUsage      `json:"usage"`
	HasUsage      bool         `json:"hasUsage"`
	FirstTokenMs  int64        `json:"firstTokenMs"`
	DurationMs    int64        `json:"durationMs"`
	Error         string       `json:"error,omitempty"`
	HTTP          HttpResponse `json:"http"`
}

type AiResponse struct {
	Steps        []AiStep     `json:"steps"`
	Messages     []AiMessage  `json:"messages"`
	Text         string       `json:"text"`
	StopReason   string       `json:"stopReason"`
	Usage        AiUsage      `json:"usage"`
	HasUsage     bool         `json:"hasUsage"`
	FirstTokenMs int64        `json:"firstTokenMs"`
	DurationMs   int64        `json:"durationMs"`
	Tools        []AiToolInfo `json:"tools"`
	Warnings     []string     `json:"warnings"`
	Error        string       `json:"error,omitempty"`
	HTTP         HttpResponse `json:"http"`
}

type AiToolInfo struct {
	Name         string `json:"name"`
	OriginalName string `json:"originalName"`
	Server       string `json:"server"`
	Description  string `json:"description,omitempty"`
}

type AiDeltaEvent struct {
	SessionID string `json:"sessionId"`
	Step      int    `json:"step"`
	Index     int    `json:"index"`
	Type      string `json:"type"`
	Text      string `json:"text,omitempty"`
	ID        string `json:"id,omitempty"`
	Name      string `json:"name,omitempty"`
	Input     string `json:"input,omitempty"`
}

type AiDeltaBatch struct {
	SessionID string         `json:"sessionId"`
	Deltas    []AiDeltaEvent `json:"deltas"`
}

type AiStepEvent struct {
	SessionID string `json:"sessionId"`
	Step      AiStep `json:"step"`
}

type AiToolResultEvent struct {
	SessionID string  `json:"sessionId"`
	Step      int     `json:"step"`
	Block     AiBlock `json:"block"`
}

func (s AiStep) withSlices() AiStep {
	if s.Blocks == nil {
		s.Blocks = []AiBlock{}
	}
	if s.ToolResults == nil {
		s.ToolResults = []AiBlock{}
	}
	s.HTTP.Headers = normalizeKeyValues(s.HTTP.Headers)
	return s
}

func NormalizeAiStep(s AiStep) AiStep {
	return s.withSlices()
}

func NormalizeAiResponse(r AiResponse) AiResponse {
	if r.Steps == nil {
		r.Steps = []AiStep{}
	}
	for i := range r.Steps {
		r.Steps[i] = r.Steps[i].withSlices()
	}
	if r.Messages == nil {
		r.Messages = []AiMessage{}
	}
	for i := range r.Messages {
		if r.Messages[i].Blocks == nil {
			r.Messages[i].Blocks = []AiBlock{}
		}
	}
	if r.Tools == nil {
		r.Tools = []AiToolInfo{}
	}
	if r.Warnings == nil {
		r.Warnings = []string{}
	}
	r.HTTP.Headers = normalizeKeyValues(r.HTTP.Headers)
	return r
}
