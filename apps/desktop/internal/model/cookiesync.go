package model

type CookieSyncConfig struct {
	Enabled bool     `json:"enabled"`
	Port    int      `json:"port"`
	Domains []string `json:"domains"`
}

type CookieSyncPairRequest struct {
	ID          string `json:"id"`
	Browser     string `json:"browser"`
	ExtensionID string `json:"extensionId"`
	Code        string `json:"code"`
	RequestedAt int64  `json:"requestedAt"`
	ExpiresAt   int64  `json:"expiresAt"`
}

type CookieSyncStatus struct {
	Enabled          bool                  `json:"enabled"`
	Running          bool                  `json:"running"`
	Port             int                   `json:"port"`
	URL              string                `json:"url"`
	PairingCode      string                `json:"pairingCode"`
	Domains          []string              `json:"domains"`
	Paired           bool                  `json:"paired"`
	Connected        bool                  `json:"connected"`
	Browser          string                `json:"browser"`
	ExtensionVersion string                `json:"extensionVersion,omitempty"`
	Unreadable       []string              `json:"unreadable"`
	LastContactAt    int64                 `json:"lastContactAt"`
	LastSyncAt       int64                 `json:"lastSyncAt"`
	LastSyncCount    int                   `json:"lastSyncCount"`
	SyncedTotal      int                   `json:"syncedTotal"`
	Pending          CookieSyncPairRequest `json:"pending"`
	Log              []CookieSyncLog       `json:"log"`
	Error            string                `json:"error,omitempty"`
}

type CookieSyncLog struct {
	ID        string `json:"id"`
	Timestamp int64  `json:"timestamp"`
	Browser   string `json:"browser"`
	Domain    string `json:"domain"`
	Accepted  int    `json:"accepted"`
	Skipped   int    `json:"skipped"`
	Removed   int    `json:"removed"`
	Message   string `json:"message"`
}
