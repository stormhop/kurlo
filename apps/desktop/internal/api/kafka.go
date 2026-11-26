package api

import (
	"context"
	"crypto/tls"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/stormhop/kurlo/apps/desktop/internal/model"
	"github.com/twmb/franz-go/pkg/kadm"
	"github.com/twmb/franz-go/pkg/kgo"
	"github.com/twmb/franz-go/pkg/sasl"
	"github.com/twmb/franz-go/pkg/sasl/aws"
	"github.com/twmb/franz-go/pkg/sasl/oauth"
	"github.com/twmb/franz-go/pkg/sasl/plain"
	"github.com/twmb/franz-go/pkg/sasl/scram"
)

type kafkaStreamKey struct{}

type kafkaHeader struct {
	Key      string  `json:"key"`
	Value    *string `json:"value"`
	Encoding string  `json:"encoding,omitempty"`
}

type kafkaRecord struct {
	Validation  string        `json:"validation,omitempty"`
	SchemaIssue string        `json:"schemaIssue,omitempty"`
	Topic       string        `json:"topic"`
	Partition   int32         `json:"partition"`
	Offset      string        `json:"offset,omitempty"`
	Timestamp   time.Time     `json:"timestamp"`
	Key         *string       `json:"key"`
	KeyEncoding string        `json:"keyEncoding,omitempty"`
	Value       *string       `json:"value"`
	Encoding    string        `json:"encoding,omitempty"`
	Headers     []kafkaHeader `json:"headers"`
}

func kafkaBytes(b []byte) (*string, string) {
	if b == nil {
		return nil, ""
	}
	if utf8.Valid(b) {
		s := string(b)
		return &s, ""
	}
	s := base64.StdEncoding.EncodeToString(b)
	return &s, "base64"
}

func kafkaRecordView(r *kgo.Record) kafkaRecord {
	key, ke := kafkaBytes(r.Key)
	value, ve := kafkaBytes(r.Value)
	record := kafkaRecord{Topic: r.Topic, Partition: r.Partition, Offset: strconv.FormatInt(r.Offset, 10), Timestamp: r.Timestamp.UTC(), Key: key, KeyEncoding: ke, Value: value, Encoding: ve, Headers: make([]kafkaHeader, 0, len(r.Headers))}
	for _, h := range r.Headers {
		v, e := kafkaBytes(h.Value)
		record.Headers = append(record.Headers, kafkaHeader{h.Key, v, e})
	}
	return record
}

func kafkaMechanism(req model.HttpRequest) (sasl.Mechanism, error) {
	a := req.Auth
	switch a.Type {
	case "", "none", "inherit":
		return nil, nil
	case "basic":
		if a.Username == "" || a.Password == "" {
			return nil, errors.New("enter the SASL username and password")
		}
		switch req.Kafka.Mechanism {
		case "", "PLAIN":
			return plain.Auth{User: a.Username, Pass: a.Password}.AsMechanism(), nil
		case "SCRAM-SHA-256":
			return scram.Auth{User: a.Username, Pass: a.Password}.AsSha256Mechanism(), nil
		case "SCRAM-SHA-512":
			return scram.Auth{User: a.Username, Pass: a.Password}.AsSha512Mechanism(), nil
		}
	case "oauth2", "bearer":
		if a.Token == "" {
			return nil, errors.New("enter a Kafka OAuth access token")
		}
		return oauth.Auth{Token: a.Token}.AsMechanism(), nil
	case "aws":
		if a.AWSAccessKey == "" || a.AWSSecretKey == "" {
			return nil, errors.New("enter AWS access and secret keys")
		}
		return aws.Auth{AccessKey: a.AWSAccessKey, SecretKey: a.AWSSecretKey, SessionToken: a.AWSSessionToken}.AsManagedStreamingIAMMechanism(), nil
	}
	return nil, errors.New("unsupported Kafka authentication or SASL mechanism")
}

func kafkaClient(req model.HttpRequest, options ...kgo.Opt) (*kgo.Client, error) {
	brokers := strings.Split(req.URL, ",")
	for i, b := range brokers {
		b = strings.TrimSpace(b)
		host, port, err := net.SplitHostPort(b)
		n, portErr := strconv.Atoi(port)
		if err != nil || host == "" || strings.ContainsAny(host, "/{} ") || portErr != nil || n <= 0 || n > 65535 {
			return nil, fmt.Errorf("bootstrap broker %d must be a host:port address", i+1)
		}
		brokers[i] = b
	}
	options = append(options, kgo.ClientID("kurlo"), kgo.SeedBrokers(brokers...), kgo.FetchMaxBytes(4<<20), kgo.FetchMaxWait(250*time.Millisecond))
	if req.Kafka.TLS {
		cfg := &tls.Config{MinVersion: tls.VersionTLS12, InsecureSkipVerify: !req.EnableSSLVerification}
		if cert := clientCertConfigFor(req); cert.enabled() {
			cert.certPath = resolveRequestFilePath(req.FileRoot, cert.certPath)
			if cert.keyPath != "" {
				cert.keyPath = resolveRequestFilePath(req.FileRoot, cert.keyPath)
			}
			pair, err := clientCerts.load(cert)
			if err != nil {
				return nil, err
			}
			cfg.Certificates = []tls.Certificate{pair}
		}
		options = append(options, kgo.DialTLSConfig(cfg))
	}
	mechanism, err := kafkaMechanism(req)
	if err != nil {
		return nil, err
	}
	if mechanism != nil {
		options = append(options, kgo.SASL(mechanism))
	}
	return kgo.NewClient(options...)
}

func (a *App) ListKafkaTopics(req model.HttpRequest) ([]string, error) {
	if req.Kafka == nil {
		return nil, errors.New("expected a Kafka request")
	}
	req = withRequestFileRoot(req, fileWorkspaceStorePath())
	ctx, cancel := context.WithTimeout(updateBaseContext(a.ctx), 10*time.Second)
	defer cancel()
	_, failed := a.linkSecretsIntoHTTP(ctx, &req)
	if failed != nil {
		return nil, errors.New(failed.Error)
	}
	if req.ResolveTemplates {
		resolved, err := resolveHTTPRequestTemplates(req, req.TemplateValues)
		if err != nil {
			return nil, err
		}
		req = resolved
	}
	cl, err := kafkaClient(req)
	if err != nil {
		return nil, err
	}
	defer cl.Close()
	topics, err := kadm.NewClient(cl).ListTopics(ctx)
	if err != nil {
		return nil, err
	}
	return topics.Names(), topics.Error()
}

func executeKafka(ctx context.Context, req model.HttpRequest, onMessage func(kafkaRecord)) model.HttpResponse {
	start := time.Now()
	if req.TimeoutMs > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, time.Duration(req.TimeoutMs)*time.Millisecond)
		defer cancel()
	}
	var records []kafkaRecord
	var err error
	var status, reason string
	switch req.Kafka.Mode {
	case "", "produce":
		records, err = produceKafka(ctx, req)
		status = "Produced"
	case "consume":
		records, err = consumeKafka(ctx, req, onMessage, &reason)
		status = "Consumed"
	default:
		err = errors.New("choose Produce or Consume")
	}
	resp := model.HttpResponse{KafkaStopReason: reason, Duration: time.Since(start).Milliseconds(), Connection: model.ConnectionInfo{Protocol: "Kafka"}}
	if records == nil {
		records = []kafkaRecord{}
	}
	body, _ := json.Marshal(records)
	resp.Body, resp.Size = string(body), int64(len(body))
	if err != nil {
		resp.Error = err.Error()
		return resp
	}
	resp.StatusCode, resp.Status = 200, status
	return resp
}

func kafkaFieldBytes(value, format, field string) ([]byte, error) {
	switch format {
	case "text":
		return []byte(value), nil
	case "json":
		if !json.Valid([]byte(value)) {
			return nil, fmt.Errorf("message %s must be valid JSON", field)
		}
		return []byte(value), nil
	case "base64", "hex":
		var b []byte
		var err error
		if format == "base64" {
			b, err = base64.StdEncoding.DecodeString(strings.TrimSpace(value))
		} else {
			b, err = hex.DecodeString(strings.TrimSpace(value))
		}
		if err != nil {
			return nil, fmt.Errorf("invalid %s %s: %w", format, field, err)
		}
		return b, nil
	default:
		return nil, fmt.Errorf("unknown Kafka %s format %q", field, format)
	}
}

func produceKafka(ctx context.Context, req model.HttpRequest) ([]kafkaRecord, error) {
	k := req.Kafka
	r := &kgo.Record{Topic: strings.TrimSpace(k.Topic)}
	if r.Topic == "" {
		return nil, errors.New("enter a Kafka topic")
	}
	if k.Timestamp != "" {
		ms, err := kafkaTimestamp(k.Timestamp)
		if err != nil {
			return nil, err
		}
		r.Timestamp = time.UnixMilli(ms)
	}
	var err error
	if k.Key != "" {
		r.Key, err = kafkaFieldBytes(k.Key, defaultString(k.KeyFormat, "text"), "key")
		if err != nil {
			return nil, err
		}
	}
	if k.Format != "tombstone" {
		r.Value, err = kafkaFieldBytes(req.Body, defaultString(k.Format, "json"), "value")
		if err != nil {
			return nil, err
		}
	}
	for _, h := range req.Headers {
		if h.Enabled {
			r.Headers = append(r.Headers, kgo.RecordHeader{Key: h.Key, Value: []byte(h.Value)})
		}
	}
	opts := []kgo.Opt{kgo.AllowIdempotentProduceCancellation()}
	if k.Partition != "" {
		n, err := strconv.ParseInt(k.Partition, 10, 32)
		if err != nil || n < 0 {
			return nil, errors.New("partition must be a nonnegative integer")
		}
		r.Partition = int32(n)
		opts = append(opts, kgo.RecordPartitioner(kgo.ManualPartitioner()))
	}
	switch k.Acks {
	case "", "all":
	case "leader":
		opts = append(opts, kgo.DisableIdempotentWrite(), kgo.RequiredAcks(kgo.LeaderAck()))
	case "none":
		opts = append(opts, kgo.DisableIdempotentWrite(), kgo.RequiredAcks(kgo.NoAck()))
	default:
		return nil, errors.New("unknown Kafka acknowledgement setting")
	}
	codecs := map[string]kgo.CompressionCodec{"": kgo.NoCompression(), "none": kgo.NoCompression(), "gzip": kgo.GzipCompression(), "snappy": kgo.SnappyCompression(), "lz4": kgo.Lz4Compression(), "zstd": kgo.ZstdCompression()}
	codec, ok := codecs[k.Compression]
	if !ok {
		return nil, errors.New("unknown Kafka compression")
	}
	opts = append(opts, kgo.ProducerBatchCompression(codec))
	cl, err := kafkaClient(req, opts...)
	if err != nil {
		return nil, err
	}
	defer cl.Close()
	schema := loadKafkaSchema(req.FileRoot, k.SchemaPath, r.Topic)
	if err := cl.ProduceSync(ctx, r).FirstErr(); err != nil {
		return nil, err
	}
	view := kafkaRecordView(r)
	schema.validate(&view)
	if k.Acks == "none" {
		view.Offset = ""
	}
	return []kafkaRecord{view}, nil
}
