package api

import (
	"context"
	"errors"
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/stormhop/kurlo/apps/desktop/internal/model"
	"github.com/twmb/franz-go/pkg/kadm"
	"github.com/twmb/franz-go/pkg/kgo"
)

const kafkaMaxRecords = 10000
const kafkaMaxBytes = 16 << 20

type kafkaPartition struct {
	topic string
	id    int32
}
type kafkaRange struct {
	start      int64
	end        int64
	schemaPath string
}

func kafkaNumber(s, label string) (int64, error) {
	n, err := strconv.ParseInt(strings.TrimSpace(s), 10, 64)
	if err != nil || n < 0 {
		return 0, fmt.Errorf("%s must be a nonnegative integer", label)
	}
	return n, nil
}

func kafkaTimestamp(s string) (int64, error) {
	if n, err := kafkaNumber(s, "timestamp"); err == nil {
		return n, nil
	}
	t, err := time.Parse(time.RFC3339, s)
	if err != nil {
		return 0, errors.New("timestamp must be RFC 3339 or Unix milliseconds")
	}
	return t.UnixMilli(), nil
}

func kafkaSubscriptions(ctx context.Context, admin *kadm.Client, rows []model.KafkaTopic) (map[string]model.KafkaTopic, error) {
	selected := map[string]model.KafkaTopic{}
	var available kadm.TopicDetails
	for _, row := range rows {
		name := strings.TrimSpace(row.Name)
		if name == "" {
			continue
		}
		if !strings.HasPrefix(name, "^") {
			selected[name] = row
			continue
		}
		re, err := regexp.Compile(name)
		if err != nil {
			return nil, fmt.Errorf("topic pattern: %w", err)
		}
		if available == nil {
			available, err = admin.ListTopics(ctx)
			if err != nil {
				return nil, err
			}
		}
		for topic := range available {
			if re.MatchString(topic) {
				selected[topic] = row
			}
		}
	}
	if len(selected) == 0 {
		return nil, errors.New("select at least one matching Kafka topic")
	}
	return selected, nil
}

func kafkaRanges(ctx context.Context, admin *kadm.Client, k *model.KafkaRequest) (map[kafkaPartition]kafkaRange, error) {
	selected, err := kafkaSubscriptions(ctx, admin, k.Topics)
	if err != nil {
		return nil, err
	}
	names := make([]string, 0, len(selected))
	for name := range selected {
		names = append(names, name)
	}
	var starts, ends kadm.ListedOffsets
	switch k.StartFrom {
	case "", "latest":
		starts, err = admin.ListEndOffsets(ctx, names...)
	case "earliest", "offset":
		starts, err = admin.ListStartOffsets(ctx, names...)
	case "timestamp":
		var ms int64
		ms, err = kafkaTimestamp(k.StartValue)
		if err == nil {
			starts, err = admin.ListOffsetsAfterMilli(ctx, ms, names...)
		}
	default:
		return nil, errors.New("unknown Kafka start position")
	}
	if err != nil {
		return nil, err
	}
	if err = starts.Error(); err != nil {
		return nil, err
	}
	if k.StopAfter == "timestamp" {
		ms, err := kafkaTimestamp(k.StopValue)
		if err != nil {
			return nil, err
		}
		if ms <= time.Now().UnixMilli() {
			ends, err = admin.ListOffsetsAfterMilli(ctx, ms, names...)
			if err != nil {
				return nil, err
			}
			if err = ends.Error(); err != nil {
				return nil, err
			}
		}
	}
	ranges := map[kafkaPartition]kafkaRange{}
	for name, row := range selected {
		partitions := starts[name]
		if len(partitions) == 0 {
			return nil, fmt.Errorf("topic %q has no accessible partitions", name)
		}
		if row.Partitions != "" {
			partitions = map[int32]kadm.ListedOffset{}
			for _, p := range strings.Split(row.Partitions, ",") {
				n, err := strconv.ParseInt(strings.TrimSpace(p), 10, 32)
				part, ok := starts[name][int32(n)]
				if err != nil || n < 0 || !ok {
					return nil, fmt.Errorf("unknown partition %q for %s", p, name)
				}
				partitions[int32(n)] = part
			}
		}
		for p, offset := range partitions {
			r := kafkaRange{start: offset.Offset, end: -1, schemaPath: row.SchemaPath}
			start := row.StartOffset
			if start == "" && k.StartFrom == "offset" {
				start = k.StartValue
				if start == "" {
					return nil, errors.New("enter a starting offset")
				}
			}
			if start != "" {
				r.start, err = kafkaNumber(start, "start offset")
				if err != nil {
					return nil, err
				}
			}
			if row.EndOffset != "" {
				r.end, err = kafkaNumber(row.EndOffset, "end offset")
				if err != nil {
					return nil, err
				}
			}
			if ends != nil {
				end, ok := ends.Lookup(name, p)
				if !ok {
					return nil, errors.New("end offset unavailable")
				}
				if r.end < 0 || end.Offset < r.end {
					r.end = end.Offset
				}
			}
			if r.end < 0 || r.start < r.end {
				ranges[kafkaPartition{name, p}] = r
			}
		}
	}
	return ranges, nil
}

func consumeKafka(ctx context.Context, req model.HttpRequest, onMessage func(kafkaRecord), reason *string) ([]kafkaRecord, error) {
	k := req.Kafka
	limit := kafkaMaxRecords
	var duration time.Duration
	var cutoff time.Time
	switch k.StopAfter {
	case "", "records":
		n, err := kafkaNumber(defaultString(k.StopValue, "1000"), "record count")
		if err != nil || n < 1 || n > kafkaMaxRecords {
			return nil, fmt.Errorf("record count must be between 1 and %d", kafkaMaxRecords)
		}
		limit = int(n)
	case "duration", "idle":
		n, err := kafkaNumber(k.StopValue, "duration")
		if err != nil || n < 1 || n > 86400000 {
			return nil, errors.New("duration must be between 1 and 86400000 ms")
		}
		duration = time.Duration(n) * time.Millisecond
	case "timestamp":
		ms, err := kafkaTimestamp(k.StopValue)
		if err != nil {
			return nil, err
		}
		cutoff = time.UnixMilli(ms)
	default:
		return nil, errors.New("unknown Kafka stop condition")
	}
	started := time.Now()
	cl, err := kafkaClient(req)
	if err != nil {
		return nil, err
	}
	defer cl.Close()
	rangesCtx, cancelRanges := kafkaTimeoutContext(ctx, req)
	ranges, err := kafkaRanges(rangesCtx, kadm.NewClient(cl), k)
	cancelRanges()
	if err != nil {
		return nil, err
	}
	schemas := map[string]kafkaSchema{}
	assign := map[string]map[int32]kgo.Offset{}
	for p, r := range ranges {
		if _, ok := schemas[p.topic]; !ok {
			schemas[p.topic] = loadKafkaSchema(req.FileRoot, r.schemaPath, p.topic)
		}
		if assign[p.topic] == nil {
			assign[p.topic] = map[int32]kgo.Offset{}
		}
		assign[p.topic][p.id] = kgo.NewOffset().At(r.start)
	}
	cl.AddConsumePartitions(assign)
	var records []kafkaRecord
	size := 0
	deadline := time.Now().Add(duration)
	emit, _ := ctx.Value(kafkaStreamKey{}).(func([]kafkaRecord))
	for len(ranges) > 0 && len(records) < limit {
		pollCtx := ctx
		cancel := func() {}
		if !cutoff.IsZero() && cutoff.After(started) {
			pollCtx, cancel = context.WithDeadline(ctx, cutoff)
		} else if duration > 0 {
			pollCtx, cancel = context.WithDeadline(ctx, deadline)
		}
		fetch := cl.PollRecords(pollCtx, min(128, limit-len(records)))
		cancel()
		if ctx.Err() != nil {
			return records, ctx.Err()
		}
		if err := fetch.Err(); err != nil {
			if (duration > 0 || !cutoff.IsZero()) && errors.Is(err, context.DeadlineExceeded) {
				break
			}
			return records, err
		}
		start := len(records)
		for _, r := range fetch.Records() {
			p := kafkaPartition{r.Topic, r.Partition}
			bounds, ok := ranges[p]
			if !ok {
				continue
			}
			pastCutoff := !cutoff.IsZero() && !r.Timestamp.Before(cutoff)
			if !pastCutoff && (bounds.end < 0 || r.Offset < bounds.end) {
				size += len(r.Topic) + len(r.Key) + len(r.Value) + 64
				for _, h := range r.Headers {
					size += len(h.Key) + len(h.Value) + 16
				}
				if size > kafkaMaxBytes {
					return records, errors.New("Kafka stream reached the 16 MiB result limit")
				}
				record := kafkaRecordView(r)
				schemas[r.Topic].validate(&record)
				if onMessage != nil {
					if ctx.Err() != nil {
						return records, ctx.Err()
					}
					onMessage(record)
				}
				records = append(records, record)
			}
			if pastCutoff || (bounds.end >= 0 && r.Offset >= bounds.end-1) {
				delete(ranges, p)
				cl.PauseFetchPartitions(map[string][]int32{p.topic: {p.id}})
			}
		}
		if len(records) > start {
			if emit != nil {
				emit(records[start:])
			}
			if k.StopAfter == "idle" {
				deadline = time.Now().Add(duration)
			}
		}
	}
	if len(records) == kafkaMaxRecords && k.StopAfter != "" && k.StopAfter != "records" {
		return records, errors.New("Kafka stream reached the 10000-record result limit")
	}
	if reason != nil {
		*reason = defaultString(k.StopAfter, "records")
		if len(ranges) == 0 && len(records) < limit && cutoff.IsZero() {
			*reason = "endOffset"
		}
	}
	return records, nil
}
