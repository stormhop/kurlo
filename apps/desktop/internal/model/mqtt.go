package model

type MqttTopic struct {
	Name        string `json:"name"`
	QoS         int    `json:"qos"`
	Enabled     bool   `json:"enabled"`
	Description string `json:"description,omitempty"`
	NoLocal     bool   `json:"noLocal,omitempty"`
	RetainAsPub bool   `json:"retainAsPublished,omitempty"`
}

type MqttPublishProperties struct {
	ContentType            string     `json:"contentType,omitempty"`
	ResponseTopic          string     `json:"responseTopic,omitempty"`
	CorrelationData        string     `json:"correlationData,omitempty"`
	MessageExpiryInterval  string     `json:"messageExpiryInterval,omitempty"`
	TopicAlias             string     `json:"topicAlias,omitempty"`
	PayloadFormatIndicator bool       `json:"payloadFormatIndicator,omitempty"`
	UserProperties         []KeyValue `json:"userProperties,omitempty"`
}

type MqttConnectProperties struct {
	SessionExpiryInterval      string     `json:"sessionExpiryInterval,omitempty"`
	ReceiveMaximum             string     `json:"receiveMaximum,omitempty"`
	MaximumPacketSize          string     `json:"maximumPacketSize,omitempty"`
	TopicAliasMaximum          string     `json:"topicAliasMaximum,omitempty"`
	RequestResponseInformation bool       `json:"requestResponseInformation,omitempty"`
	RequestProblemInformation  bool       `json:"requestProblemInformation,omitempty"`
	UserProperties             []KeyValue `json:"userProperties,omitempty"`
}

type MqttWill struct {
	Enabled       bool                  `json:"enabled,omitempty"`
	Topic         string                `json:"topic,omitempty"`
	Payload       string                `json:"payload,omitempty"`
	Format        string                `json:"format,omitempty"`
	QoS           int                   `json:"qos,omitempty"`
	Retain        bool                  `json:"retain,omitempty"`
	DelayInterval string                `json:"delayInterval,omitempty"`
	Properties    MqttPublishProperties `json:"properties,omitempty"`
}

type MqttRequest struct {
	Version           string                `json:"version,omitempty"`
	ClientID          string                `json:"clientId,omitempty"`
	CleanSession      bool                  `json:"cleanSession"`
	KeepAliveSec      int                   `json:"keepAliveSec,omitempty"`
	ConnectTimeoutMs  int                   `json:"connectTimeoutMs,omitempty"`
	AutoReconnect     bool                  `json:"autoReconnect,omitempty"`
	Topic             string                `json:"topic,omitempty"`
	QoS               int                   `json:"qos,omitempty"`
	Retain            bool                  `json:"retain,omitempty"`
	Format            string                `json:"format,omitempty"`
	Topics            []MqttTopic           `json:"topics,omitempty"`
	Properties        MqttPublishProperties `json:"properties,omitempty"`
	ConnectProperties MqttConnectProperties `json:"connectProperties,omitempty"`
	Will              MqttWill              `json:"will,omitempty"`
}

type MqttPublishMessage struct {
	Topic      string                `json:"topic"`
	Payload    string                `json:"payload"`
	Format     string                `json:"format,omitempty"`
	QoS        int                   `json:"qos"`
	Retain     bool                  `json:"retain"`
	Properties MqttPublishProperties `json:"properties,omitempty"`
}

type MqttResult struct {
	OK    bool   `json:"ok"`
	Error string `json:"error,omitempty"`
}

type MqttMessage struct {
	ID              string     `json:"id"`
	Direction       string     `json:"direction"`
	Topic           string     `json:"topic,omitempty"`
	Payload         string     `json:"payload,omitempty"`
	Encoding        string     `json:"encoding,omitempty"`
	Truncated       bool       `json:"truncated,omitempty"`
	Size            int        `json:"size"`
	QoS             int        `json:"qos"`
	Retain          bool       `json:"retain,omitempty"`
	Duplicate       bool       `json:"duplicate,omitempty"`
	ContentType     string     `json:"contentType,omitempty"`
	ResponseTopic   string     `json:"responseTopic,omitempty"`
	CorrelationData string     `json:"correlationData,omitempty"`
	UserProperties  []KeyValue `json:"userProperties,omitempty"`
	Timestamp       int64      `json:"timestamp"`
	IsSystem        bool       `json:"isSystem"`
	IsError         bool       `json:"isError"`
	Message         string     `json:"message,omitempty"`
}

type MqttOpenEvent struct {
	SessionID      string `json:"sessionId"`
	URL            string `json:"url"`
	ClientID       string `json:"clientId"`
	Version        string `json:"version"`
	SessionPresent bool   `json:"sessionPresent"`
	Timestamp      int64  `json:"timestamp"`
}

type MqttCloseEvent struct {
	SessionID string `json:"sessionId"`
	Message   string `json:"message"`
	Timestamp int64  `json:"timestamp"`
}

type MqttErrorEvent struct {
	SessionID string `json:"sessionId"`
	Message   string `json:"message"`
	Timestamp int64  `json:"timestamp"`
}

type MqttReconnectEvent struct {
	SessionID string `json:"sessionId"`
	Attempt   int    `json:"attempt"`
	Timestamp int64  `json:"timestamp"`
}

type MqttBatchPayload struct {
	SessionID string        `json:"sessionId"`
	Messages  []MqttMessage `json:"messages"`
}
