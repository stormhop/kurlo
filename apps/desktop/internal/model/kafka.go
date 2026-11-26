package model

type KafkaTopic struct {
	SchemaPath  string `json:"schemaPath,omitempty"`
	Name        string `json:"name"`
	Partitions  string `json:"partitions,omitempty"`
	StartOffset string `json:"startOffset,omitempty"`
	EndOffset   string `json:"endOffset,omitempty"`
}

type KafkaRequest struct {
	OnMessage   string       `json:"onMessage,omitempty"`
	SchemaPath  string       `json:"schemaPath,omitempty"`
	Timestamp   string       `json:"timestamp,omitempty"`
	Mode        string       `json:"mode,omitempty"`
	Topic       string       `json:"topic,omitempty"`
	Topics      []KafkaTopic `json:"topics,omitempty"`
	KeyFormat   string       `json:"keyFormat,omitempty"`
	Key         string       `json:"key,omitempty"`
	Partition   string       `json:"partition,omitempty"`
	Format      string       `json:"format,omitempty"`
	Acks        string       `json:"acks,omitempty"`
	Compression string       `json:"compression,omitempty"`
	TLS         bool         `json:"tls,omitempty"`
	Mechanism   string       `json:"mechanism,omitempty"`
	StartFrom   string       `json:"startFrom,omitempty"`
	StartValue  string       `json:"startValue,omitempty"`
	StopAfter   string       `json:"stopAfter,omitempty"`
	StopValue   string       `json:"stopValue,omitempty"`
}
