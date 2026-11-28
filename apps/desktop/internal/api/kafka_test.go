package api

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/stormhop/kurlo/apps/desktop/internal/model"
	"github.com/twmb/franz-go/pkg/kfake"
	"github.com/twmb/franz-go/pkg/kgo"
)

func kafkaTestBroker(t *testing.T, opts ...kfake.Opt) (string, string) {
	t.Helper()
	if broker := os.Getenv("KURLO_TEST_KAFKA_BROKER"); broker != "" && len(opts) == 0 {
		topic := os.Getenv("KURLO_TEST_KAFKA_TOPIC")
		if topic == "" {
			t.Fatal("set KURLO_TEST_KAFKA_TOPIC to a disposable topic with two partitions")
		}
		return broker, topic
	}
	topic := "kurlo.orders"
	cluster, err := kfake.NewCluster(append([]kfake.Opt{kfake.NumBrokers(1), kfake.SeedTopics(2, topic)}, opts...)...)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(cluster.Close)
	return strings.Join(cluster.ListenAddrs(), ","), topic
}

func TestKafkaProducerRejectsInvalidInputBeforeConnecting(t *testing.T) {
	t.Parallel()
	for _, tc := range []struct{ format, value, partition, want string }{
		{"json", "nope", "", "valid JSON"}, {"base64", "$", "", "base64"}, {"hex", "f", "", "hex"}, {"text", "ok", "-1", "partition"},
	} {
		resp := NewApp().SendRequest(model.HttpRequest{URL: "localhost:9092", Kafka: &model.KafkaRequest{Mode: "produce", Topic: "orders", Format: tc.format, Partition: tc.partition}, Body: tc.value})
		if !strings.Contains(resp.Error, tc.want) {
			t.Fatalf("%s: %+v", tc.format, resp)
		}
	}
}

func TestKafkaBrokerRoundTrip(t *testing.T) {
	t.Parallel()
	broker, topic := kafkaTestBroker(t)
	app := NewApp()
	req := model.HttpRequest{URL: "{{brokers}}", ResolveTemplates: true, TemplateValues: map[string]string{"brokers": broker, "topic": topic, "order": "42"}, Kafka: &model.KafkaRequest{Topic: "{{topic}}", Key: "order-{{order}}", Format: "json", Partition: "1"}, Body: `{"order":"{{order}}"}`, BodyType: "text", Headers: []model.KeyValue{{Key: "trace", Value: "t1", Enabled: true}}, TimeoutMs: 8000, EnableSSLVerification: true}
	topics, err := app.ListKafkaTopics(req)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, name := range topics {
		found = found || name == topic
	}
	if !found {
		t.Fatalf("missing topic %s", topic)
	}
	req.PreRequestScript = `pm.request.value = {order:"42"}; pm.request.key = "order-42"`
	send := app.SendRequest(req)
	if send.Error != "" {
		t.Fatal(send.Error)
	}
	var produced []kafkaRecord
	if err := json.Unmarshal([]byte(send.Body), &produced); err != nil || len(produced) != 1 || produced[0].Partition != 1 || produced[0].Offset == "" {
		t.Fatalf("produce: %s", send.Body)
	}
	req.Kafka = &model.KafkaRequest{Mode: "consume", Topics: []model.KafkaTopic{{Name: topic, Partitions: "1"}}, StartFrom: "offset", StartValue: produced[0].Offset, StopAfter: "records", StopValue: "1"}
	req.PreRequestScript = ""
	req.Kafka.OnMessage = `pm.test("message value", () => pm.expect(pm.message.value.order).to.eql("42")); pm.environment.set("lastOrder",pm.message.value.order)`
	req.TestScript = `pm.test("order", () => pm.expect(pm.response.messages[0].key).to.eql("order-42"))`
	consume := app.SendRequest(req)
	var records []kafkaRecord
	if consume.Error != "" || json.Unmarshal([]byte(consume.Body), &records) != nil || len(records) != 1 || *records[0].Value != `{"order":"42"}` || *records[0].Headers[0].Value != "t1" || len(consume.TestResult.Tests) != 2 || !consume.TestResult.Tests[0].Passed || !consume.TestResult.Tests[1].Passed || consume.EnvironmentUpdates["lastOrder"] != "42" {
		t.Fatalf("consume: %+v", consume)
	}
	next, _ := strconv.ParseInt(produced[0].Offset, 10, 64)
	req.Kafka.StartValue = strconv.FormatInt(next+1, 10)
	req.Kafka.StopAfter = "idle"
	req.Kafka.StopValue = "180"
	req.TestScript = ""
	empty := app.SendRequest(req)
	if empty.Error != "" || empty.Body != "[]" {
		t.Fatalf("idle: %+v", empty)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := consumeKafka(ctx, model.HttpRequest{URL: broker, Kafka: req.Kafka}, nil, nil); err == nil {
		t.Fatal("expected cancellation")
	}
	for _, acks := range []string{"none", "leader"} {
		req.Kafka = &model.KafkaRequest{Topic: topic, Format: "hex", Acks: acks}
		req.Body = "ff00"
		req.PreRequestScript = ""
		resp := app.SendRequest(req)
		if resp.Error != "" {
			t.Fatal(resp.Error)
		}
		records = nil
		if err := json.Unmarshal([]byte(resp.Body), &records); err != nil || len(records) != 1 || records[0].Encoding != "base64" || (records[0].Offset == "") != (acks == "none") {
			t.Fatalf("%s: %+v", acks, resp)
		}
	}
	req.Kafka = &model.KafkaRequest{Topic: topic, Partition: "1", Key: "ff00", KeyFormat: "hex", Format: "tombstone"}
	receipt := app.SendRequest(req)
	records = nil
	if receipt.Error != "" || json.Unmarshal([]byte(receipt.Body), &records) != nil || len(records) != 1 || records[0].KeyEncoding != "base64" || records[0].Value != nil {
		t.Fatal(receipt)
	}
	req.Kafka = &model.KafkaRequest{Mode: "consume", Topics: []model.KafkaTopic{{Name: "^" + regexp.QuoteMeta(topic) + "$", Partitions: "1"}}, StartFrom: "offset", StartValue: records[0].Offset, StopAfter: "timestamp", StopValue: strconv.FormatInt(time.Now().Add(800*time.Millisecond).UnixMilli(), 10)}
	req.Kafka.OnMessage = ""
	resp := app.SendRequest(req)
	if resp.Error != "" || resp.KafkaStopReason != "timestamp" {
		t.Fatal(resp)
	}
	req.Kafka.StartFrom = "latest"
	req.Kafka.StopAfter = "records"
	req.Kafka.StopValue = "1"
	req.URL = broker
	ctx, cancel = context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()
	if _, err := consumeKafka(ctx, req, nil, nil); !errors.Is(err, context.DeadlineExceeded) {
		t.Fatal("active fetch cancellation", err)
	}
}

func TestKafkaTemplateDoesNotMutateSavedTopicBounds(t *testing.T) {
	t.Parallel()
	req := model.HttpRequest{Kafka: &model.KafkaRequest{Topics: []model.KafkaTopic{{Name: "{{topic}}", EndOffset: "{{end}}"}}}}
	got, err := resolveHTTPRequestTemplates(req, map[string]string{"topic": "payments", "end": "42"})
	if err != nil || got.Kafka.Topics[0].Name != "payments" || got.Kafka.Topics[0].EndOffset != "42" || req.Kafka.Topics[0].EndOffset != "{{end}}" {
		t.Fatal(got, err)
	}
	if ms, err := kafkaTimestamp("2026-01-01T00:00:00Z"); err != nil || time.UnixMilli(ms).UTC().Year() != 2026 {
		t.Fatal(ms, err)
	}
}

func TestKafkaBrokerAuthentication(t *testing.T) {
	t.Parallel()
	for _, mechanism := range []string{"PLAIN", "SCRAM-SHA-256", "SCRAM-SHA-512"} {
		t.Run(mechanism, func(t *testing.T) {
			_, _, cert := issueCert(t, "localhost")
			broker, _ := kafkaTestBroker(t, kfake.EnableSASL(), kfake.Superuser(mechanism, "kurlo", "fixture"), kfake.TLS(&tls.Config{Certificates: []tls.Certificate{cert}}))
			req := model.HttpRequest{URL: broker, TimeoutMs: 4000, Auth: model.AuthConfig{Type: "basic", Username: "kurlo", Password: "fixture"}, Kafka: &model.KafkaRequest{TLS: true, Mechanism: mechanism, Topic: "kurlo.orders", Format: "text"}, Body: "authenticated"}
			resp := NewApp().SendRequest(req)
			if resp.Error != "" || resp.Status != "Produced" {
				t.Fatal(resp.Error, resp.Status)
			}
		})
	}
}

func TestKafkaSavedRequestRunsFromCLI(t *testing.T) {
	t.Parallel()
	broker, topic := kafkaTestBroker(t)
	root := writeDefaultsWorkspace(t, broker, "    settings: {}", "")
	path := filepath.Join(root, "workspaces/Demo/collections/Smoke/requests/GET-x.yml")
	data := fmt.Sprintf("version: 1\nrequest:\n  id: req\n  collectionId: col\n  name: Kafka smoke\n  requestType: kafka\n  url: %s\n  bodyType: text\n  bodyContent: cli-record\n  kafka:\n    mode: produce\n    topic: %s\n    format: text\n  testScriptJs: |\n    pm.test('CLI Kafka receipt', () => pm.expect(pm.response.code).to.eql(200))\n", broker, topic)
	if err := os.WriteFile(path, []byte(data), 0600); err != nil {
		t.Fatal(err)
	}
	var out bytes.Buffer
	status := runCLI(cliOptions{workspace: root, iterations: 1, reporters: []string{"json"}, stdout: &out, stderr: &out})
	if status != 0 || !strings.Contains(out.String(), "CLI Kafka receipt") {
		t.Fatal(status, out.String())
	}
}

func TestKafkaAsyncAPISchema(t *testing.T) {
	t.Parallel()
	root := t.TempDir()
	data := []byte("asyncapi: 3.0.0\nchannels:\n  orderEvents:\n    address: orders\n    messages:\n      order:\n        $ref: '#/components/messages/Order'\ncomponents:\n  messages:\n    Order:\n      payload:\n        $ref: '#/components/schemas/Order'\n  schemas:\n    Order:\n      type: object\n      required: [id]\n")
	if err := os.WriteFile(filepath.Join(root, "schema.yaml"), data, 0600); err != nil {
		t.Fatal(err)
	}
	s := loadKafkaSchema(root, "schema.yaml", "orders")
	for value, expected := range map[string]string{`{"id":2}`: "Valid", `{}`: "Invalid"} {
		rec := kafkaRecord{Value: &value}
		s.validate(&rec)
		if rec.Validation != expected {
			t.Fatalf("%s: %+v", value, rec)
		}
	}
}

func TestKafkaRejectsWrongPassword(t *testing.T) {
	broker, topic := kafkaTestBroker(t, kfake.EnableSASL(), kfake.Superuser("SCRAM-SHA-256", "kurlo", "fixture"))
	auth := model.AuthConfig{Type: "basic", Username: "kurlo", Password: "wrong"}
	for _, kafka := range []*model.KafkaRequest{
		{Mechanism: "SCRAM-SHA-256", Topic: topic, Format: "text"},
		{Mechanism: "SCRAM-SHA-256", Mode: "consume", Topics: []model.KafkaTopic{{Name: topic}}, StartFrom: "earliest"},
	} {
		started := time.Now()
		resp := NewApp().SendRequest(model.HttpRequest{URL: broker, TimeoutMs: 3000, Auth: auth, Kafka: kafka, Body: "x"})
		if resp.Status != "" || !strings.Contains(resp.Error, "sign in") || strings.Contains(resp.Error, "did not answer") {
			t.Fatalf("%s with a wrong password: %+v", defaultString(kafka.Mode, "produce"), resp)
		}
		if elapsed := time.Since(started); elapsed > time.Second {
			t.Fatalf("%s waited %s for a rejected sign-in", defaultString(kafka.Mode, "produce"), elapsed)
		}
	}
	if _, err := NewApp().ListKafkaTopics(model.HttpRequest{URL: broker, Auth: auth, Kafka: &model.KafkaRequest{Mechanism: "SCRAM-SHA-256"}}); err == nil || !strings.Contains(err.Error(), "sign in") {
		t.Fatalf("Test connection with a wrong password: %v", err)
	}
}

func TestKafkaConsumeOutsideTheWindowStopsAfterTheRequestTimeout(t *testing.T) {
	broker, topic := kafkaTestBroker(t)
	req := model.HttpRequest{URL: broker, TimeoutMs: 300, Kafka: &model.KafkaRequest{Mode: "consume", Topics: []model.KafkaTopic{{Name: topic}}, StartFrom: "latest", StopAfter: "records", StopValue: "1000"}}
	started := time.Now()
	resp := NewApp().SendRequest(req)
	if resp.Error != "" || resp.Status != "Consumed" || resp.KafkaStopReason != "timeout" || resp.Body != "[]" {
		t.Fatalf("unattended consume: %+v", resp)
	}
	if elapsed := time.Since(started); elapsed < 300*time.Millisecond || elapsed > 3*time.Second {
		t.Fatalf("unattended consume took %s", elapsed)
	}

	streamed := context.WithValue(t.Context(), kafkaStreamKey{}, func([]kafkaRecord) {})
	ctx, cancel := context.WithTimeout(streamed, 900*time.Millisecond)
	defer cancel()
	var reason string
	records, err := consumeKafka(ctx, req, nil, &reason)
	if !errors.Is(err, context.DeadlineExceeded) || len(records) != 0 {
		t.Fatalf("a consume shown in the window stopped on its own: records=%d err=%v reason=%q", len(records), err, reason)
	}
}

func TestKafkaCompressedRecordsRoundTrip(t *testing.T) {
	t.Parallel()
	broker, topic := kafkaTestBroker(t)
	app := NewApp()
	codecs := []string{"none", "gzip", "snappy", "lz4", "zstd"}
	for _, codec := range codecs {
		resp := app.SendRequest(model.HttpRequest{URL: broker, TimeoutMs: 5000, Kafka: &model.KafkaRequest{Topic: topic, Partition: "0", Format: "text", Compression: codec}, Body: "value-" + codec})
		if resp.Error != "" {
			t.Fatalf("%s: %s", codec, resp.Error)
		}
	}
	resp := app.SendRequest(model.HttpRequest{URL: broker, TimeoutMs: 5000, Kafka: &model.KafkaRequest{Mode: "consume", Topics: []model.KafkaTopic{{Name: topic, Partitions: "0"}}, StartFrom: "earliest", StopAfter: "records", StopValue: strconv.Itoa(len(codecs))}})
	var records []kafkaRecord
	if resp.Error != "" || json.Unmarshal([]byte(resp.Body), &records) != nil || len(records) != len(codecs) {
		t.Fatalf("consume: %+v", resp)
	}
	for i, codec := range codecs {
		if *records[i].Value != "value-"+codec {
			t.Fatalf("%s: %q", codec, *records[i].Value)
		}
	}
}

func TestKafkaStreamKeepsRecordsAtTheResultLimit(t *testing.T) {
	t.Parallel()
	broker, topic := kafkaTestBroker(t)
	cl, err := kgo.NewClient(kgo.SeedBrokers(strings.Split(broker, ",")...), kgo.RecordPartitioner(kgo.ManualPartitioner()))
	if err != nil {
		t.Fatal(err)
	}
	defer cl.Close()
	batch := make([]*kgo.Record, kafkaMaxRecords+50)
	for i := range batch {
		batch[i] = &kgo.Record{Topic: topic, Partition: 0, Value: []byte(strconv.Itoa(i))}
	}
	if err := cl.ProduceSync(context.Background(), batch...).FirstErr(); err != nil {
		t.Fatal(err)
	}
	resp := NewApp().SendRequest(model.HttpRequest{URL: broker, TimeoutMs: 20000, Kafka: &model.KafkaRequest{Mode: "consume", Topics: []model.KafkaTopic{{Name: topic, Partitions: "0"}}, StartFrom: "earliest", StopAfter: "duration", StopValue: "10000"}})
	var records []kafkaRecord
	if !strings.Contains(resp.Error, "10000-record") || json.Unmarshal([]byte(resp.Body), &records) != nil || len(records) != kafkaMaxRecords {
		t.Fatalf("limit: %s, %d records", resp.Error, len(records))
	}
}

func TestKafkaPostmanExtensionImportsAsKafka(t *testing.T) {
	t.Parallel()
	doc := map[string]any{"info": map[string]any{"name": "Events"}, "item": []any{map[string]any{
		"name":    "Order created",
		"request": map[string]any{"method": "POST", "url": "localhost:9092"},
		"x-kurlo": map[string]any{"requestType": "kafka", "message": `{"id":1}`, "kafka": map[string]any{"mode": "consume", "topics": []any{map[string]any{"name": "orders"}}, "stopAfter": "records", "stopValue": "5"}},
	}}}
	out, err := importPostman(doc, "fallback")
	if err != nil || len(out.requests) != 1 {
		t.Fatal(err, out.requests)
	}
	req := out.requests[0]
	kafka := nestedMap(req, "kafka")
	if req["requestType"] != "kafka" || req["bodyContent"] != `{"id":1}` || kafka == nil || kafka["mode"] != "consume" || kafka["stopValue"] != "5" {
		t.Fatalf("%+v", req)
	}
}

func TestKafkaCollectionDocsDescribeTheSubscription(t *testing.T) {
	t.Parallel()
	consume := collectionDocsEndpoint(cliSavedRequest{ID: "c", Name: "Orders stream", RequestType: "kafka", URL: "localhost:9092", Kafka: &model.KafkaRequest{Mode: "consume", Topics: []model.KafkaTopic{{Name: "orders", Partitions: "0,1"}}, StartFrom: "earliest", StopAfter: "records", StopValue: "5"}}, nil)
	produce := collectionDocsEndpoint(cliSavedRequest{ID: "p", Name: "Order created", RequestType: "kafka", URL: "localhost:9092", BodyContent: `{"id":1}`, Kafka: &model.KafkaRequest{Topic: "orders", Key: "order-1"}}, nil)
	text := func(e docsEndpoint) string {
		out := e.Message.Method
		for _, table := range e.Message.Tables {
			out += "|" + table.Title
			for _, row := range table.Rows {
				out += ";" + row.Key + "=" + row.Value
			}
		}
		return out + "|" + e.Curl
	}
	if got := text(consume); got != "Kafka|Topics;orders=0,1|Consumer;Start from=earliest;Stop after=records 5|" {
		t.Fatal(got)
	}
	if got := text(produce); !strings.HasPrefix(got, "Kafka|Record;Topic=orders;Key=order-1") || strings.Contains(got, "curl") {
		t.Fatal(got)
	}
}

func TestKafkaConsumeWaitsPastRequestTimeout(t *testing.T) {
	broker, topic := kafkaTestBroker(t)
	app := NewApp()
	req := model.HttpRequest{URL: broker, TimeoutMs: 150, Kafka: &model.KafkaRequest{Mode: "consume", Topics: []model.KafkaTopic{{Name: topic}}, StartFrom: "latest", StopAfter: "duration", StopValue: "600"}}
	started := time.Now()
	resp := app.SendRequest(req)
	if resp.Error != "" || resp.KafkaStopReason != "duration" || time.Since(started) < 600*time.Millisecond {
		t.Fatalf("consume stopped early: %+v", resp)
	}
}

func TestKafkaRequestTimeoutExplainsUnreachableBrokers(t *testing.T) {
	t.Parallel()
	broker, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer broker.Close()
	resp := NewApp().SendRequest(model.HttpRequest{URL: broker.Addr().String(), TimeoutMs: 200, Kafka: &model.KafkaRequest{Mode: "consume", Topics: []model.KafkaTopic{{Name: "orders"}}, StopAfter: "records", StopValue: "1"}})
	if !strings.Contains(resp.Error, "did not answer within 200 ms") {
		t.Fatalf("unexpected error: %q", resp.Error)
	}
}

func TestKafkaProducerRefusesAMessageThatBreaksItsSchema(t *testing.T) {
	broker, topic := kafkaTestBroker(t)
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "order.json"), []byte(`{"type":"object","required":["id"]}`), 0600); err != nil {
		t.Fatal(err)
	}
	req := model.HttpRequest{URL: broker, TimeoutMs: 5000, Body: `{}`, Kafka: &model.KafkaRequest{Topic: topic, Partition: "0", Format: "json", SchemaPath: filepath.Join(root, "order.json")}}
	refused := NewApp().SendRequest(req)
	if !strings.Contains(refused.Error, "does not match the schema") || refused.Body != "[]" {
		t.Fatalf("invalid message: %+v", refused)
	}
	req.Body = `{"id":7}`
	sent := NewApp().SendRequest(req)
	var records []kafkaRecord
	if sent.Error != "" || json.Unmarshal([]byte(sent.Body), &records) != nil || len(records) != 1 || records[0].Validation != "Valid" || records[0].Offset != "0" {
		t.Fatalf("valid message: %+v", sent)
	}
}

func TestKafkaConsumeStopsAtTheEndOfATransactionalTopic(t *testing.T) {
	broker, topic := kafkaTestBroker(t)
	producer, err := kgo.NewClient(kgo.SeedBrokers(strings.Split(broker, ",")...), kgo.TransactionalID("kurlo-test"), kgo.DefaultProduceTopic(topic), kgo.RecordPartitioner(kgo.ManualPartitioner()))
	if err != nil {
		t.Fatal(err)
	}
	defer producer.Close()
	if err := producer.BeginTransaction(); err != nil {
		t.Fatal(err)
	}
	if err := producer.ProduceSync(t.Context(), &kgo.Record{Partition: 0, Value: []byte(`{"id":1}`)}).FirstErr(); err != nil {
		t.Fatal(err)
	}
	if err := producer.EndTransaction(t.Context(), kgo.TryCommit); err != nil {
		t.Fatal(err)
	}
	req := model.HttpRequest{URL: broker, Kafka: &model.KafkaRequest{Mode: "consume", Topics: []model.KafkaTopic{{Name: topic, Partitions: "0", EndOffset: "2"}}, StartFrom: "earliest"}}
	ctx, cancel := context.WithTimeout(t.Context(), 5*time.Second)
	defer cancel()
	var reason string
	records, err := consumeKafka(ctx, req, nil, &reason)
	if err != nil || len(records) != 1 || reason != "endOffset" || *records[0].Value != `{"id":1}` {
		t.Fatalf("records=%d reason=%q err=%v", len(records), reason, err)
	}
}
