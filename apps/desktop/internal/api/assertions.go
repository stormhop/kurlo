package api

import (
	"bytes"
	"encoding/json"
	"fmt"
	"math/big"
	"reflect"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/stormhop/kurlo/apps/desktop/internal/model"
)

const (
	maxAssertionValueInName = 60
	maxRequestAssertions    = 200
)

var assertionOperatorLabels = map[string]string{
	"eq":          "equals",
	"neq":         "does not equal",
	"gt":          "is greater than",
	"gte":         "is at least",
	"lt":          "is less than",
	"lte":         "is at most",
	"in":          "is one of",
	"notIn":       "is not one of",
	"contains":    "contains",
	"notContains": "does not contain",
	"matches":     "matches",
	"exists":      "exists",
	"notExists":   "does not exist",
	"type":        "is of type",
	"length":      "has length",
}

var assertionOperatorsWithoutValue = map[string]bool{"exists": true, "notExists": true}

func assertionOperatorNames() []string {
	return []string{"eq", "neq", "gt", "gte", "lt", "lte", "in", "notIn", "contains", "notContains", "matches", "exists", "notExists", "type", "length"}
}

type assertionValue struct {
	present bool
	value   any
}

type assertionSubject struct {
	resp     model.HttpResponse
	parsed   bool
	body     any
	bodyJSON bool
}

func runAssertions(assertions []model.Assertion, resp model.HttpResponse) []model.TestResult {
	subject := &assertionSubject{resp: resp}
	var results []model.TestResult
	for _, assertion := range assertions {
		if !assertion.Enabled || strings.TrimSpace(assertion.Target) == "" {
			continue
		}
		results = append(results, subject.evaluate(assertion))
	}
	return results
}

func assertionName(assertion model.Assertion) string {
	target := strings.TrimSpace(assertion.Target)
	operator := strings.TrimSpace(assertion.Operator)
	label := assertionOperatorLabels[operator]
	if label == "" {
		label = operator
	}
	if assertionOperatorsWithoutValue[operator] {
		return target + " " + label
	}
	value := strings.TrimSpace(assertion.Value)
	if utf8.RuneCountInString(value) > maxAssertionValueInName {
		value = string([]rune(value)[:maxAssertionValueInName]) + "…"
	}
	return target + " " + label + " " + value
}

func (s *assertionSubject) evaluate(assertion model.Assertion) model.TestResult {
	result := model.TestResult{Name: assertionName(assertion)}
	operator := strings.TrimSpace(assertion.Operator)
	if _, ok := assertionOperatorLabels[operator]; !ok {
		result.Error = fmt.Sprintf("unknown operator %q", assertion.Operator)
		return result
	}
	if s.resp.Error != "" {
		result.Error = "no response to check: " + s.resp.Error
		return result
	}
	if s.resp.Skipped {
		result.Error = "the request was skipped"
		return result
	}
	actual, err := s.lookup(strings.TrimSpace(assertion.Target))
	if err != nil {
		result.Error = err.Error()
		return result
	}
	passed, failure := compareAssertion(actual, operator, assertion.Value)
	result.Passed = passed
	if !passed {
		result.Error = failure
	}
	return result
}

func (s *assertionSubject) lookup(target string) (assertionValue, error) {
	lower := strings.ToLower(target)
	switch {
	case lower == "status":
		return assertionValue{present: true, value: json.Number(strconv.Itoa(s.resp.StatusCode))}, nil
	case lower == "responsetime":
		return assertionValue{present: true, value: json.Number(strconv.FormatInt(s.resp.Duration, 10))}, nil
	case lower == "size":
		return assertionValue{present: true, value: json.Number(strconv.FormatInt(s.resp.Size, 10))}, nil
	case strings.HasPrefix(lower, "header.") || strings.HasPrefix(lower, "headers."):
		name := target[strings.Index(target, ".")+1:]
		for _, header := range s.resp.Headers {
			if strings.EqualFold(header.Key, name) {
				return assertionValue{present: true, value: header.Value}, nil
			}
		}
		return assertionValue{}, nil
	case lower == "body" || lower == "$":
		if err := s.parseBody(); err != nil {
			return assertionValue{}, err
		}
		return assertionValue{present: true, value: s.body}, nil
	case strings.HasPrefix(lower, "body.") || strings.HasPrefix(lower, "body[") || strings.HasPrefix(target, "$.") || strings.HasPrefix(target, "$["):
		path := target[1:]
		if !strings.HasPrefix(target, "$") {
			path = target[len("body"):]
		}
		if err := s.parseBody(); err != nil {
			return assertionValue{}, err
		}
		if !s.bodyJSON {
			return assertionValue{}, fmt.Errorf("the body is not JSON, so %s cannot be read", target)
		}
		segments, err := parseAssertionPath(path)
		if err != nil {
			return assertionValue{}, fmt.Errorf("%s: %v", target, err)
		}
		return walkAssertionPath(s.body, segments), nil
	default:
		return assertionValue{}, fmt.Errorf("unknown target %q: use status, responseTime, size, header.<name>, body or body.<path>", target)
	}
}

func (s *assertionSubject) parseBody() error {
	if s.parsed {
		return nil
	}
	s.parsed = true
	if s.resp.BodyOmitted || s.resp.BodyIsBinary {
		return fmt.Errorf("the body was not kept as text, so it cannot be checked")
	}
	decoder := json.NewDecoder(strings.NewReader(s.resp.Body))
	decoder.UseNumber()
	var value any
	if err := decoder.Decode(&value); err == nil && !decoder.More() {
		s.body = value
		s.bodyJSON = true
		return nil
	}
	s.body = s.resp.Body
	return nil
}

type assertionSegment struct {
	key     string
	index   int
	isIndex bool
}

func parseAssertionPath(path string) ([]assertionSegment, error) {
	var segments []assertionSegment
	for i := 0; i < len(path); {
		switch path[i] {
		case '.':
			i++
			start := i
			for i < len(path) && path[i] != '.' && path[i] != '[' {
				i++
			}
			if start == i {
				return nil, fmt.Errorf("empty name in path")
			}
			segments = append(segments, assertionSegment{key: path[start:i]})
		case '[':
			end := strings.IndexByte(path[i:], ']')
			if end < 0 {
				return nil, fmt.Errorf("missing ] in path")
			}
			inner := strings.TrimSpace(path[i+1 : i+end])
			i += end + 1
			if len(inner) >= 2 && (inner[0] == '"' || inner[0] == '\'') && inner[len(inner)-1] == inner[0] {
				segments = append(segments, assertionSegment{key: inner[1 : len(inner)-1]})
				continue
			}
			index, err := strconv.Atoi(inner)
			if err != nil {
				return nil, fmt.Errorf("[%s] is not an index or a quoted name", inner)
			}
			segments = append(segments, assertionSegment{index: index, isIndex: true})
		default:
			return nil, fmt.Errorf("expected . or [ at %q", path[i:])
		}
	}
	return segments, nil
}

func walkAssertionPath(value any, segments []assertionSegment) assertionValue {
	current := value
	for _, segment := range segments {
		if segment.isIndex {
			list, ok := current.([]any)
			if !ok {
				return assertionValue{}
			}
			index := segment.index
			if index < 0 {
				index += len(list)
			}
			if index < 0 || index >= len(list) {
				return assertionValue{}
			}
			current = list[index]
			continue
		}
		object, ok := current.(map[string]any)
		if !ok {
			return assertionValue{}
		}
		next, ok := object[segment.key]
		if !ok {
			return assertionValue{}
		}
		current = next
	}
	return assertionValue{present: true, value: current}
}

func parseAssertionExpected(text string) any {
	trimmed := strings.TrimSpace(text)
	if trimmed == "" {
		return ""
	}
	decoder := json.NewDecoder(strings.NewReader(trimmed))
	decoder.UseNumber()
	var value any
	if err := decoder.Decode(&value); err == nil && !decoder.More() {
		return value
	}
	return trimmed
}

func assertionList(text string) []any {
	if parsed, ok := parseAssertionExpected(text).([]any); ok {
		return parsed
	}
	var out []any
	for _, part := range strings.Split(text, ",") {
		if part = strings.TrimSpace(part); part != "" {
			out = append(out, parseAssertionExpected(part))
		}
	}
	return out
}

func compareAssertion(actual assertionValue, operator, expectedText string) (bool, string) {
	switch operator {
	case "exists":
		if actual.present {
			return true, ""
		}
		return false, "it is missing"
	case "notExists":
		if !actual.present {
			return true, ""
		}
		return false, "found " + describeAssertionValue(actual.value)
	}
	if !actual.present {
		return false, "it is missing"
	}
	got := "got " + describeAssertionValue(actual.value)
	switch operator {
	case "eq":
		return assertionEqual(actual.value, expectedText), got
	case "neq":
		return !assertionEqual(actual.value, expectedText), got
	case "gt", "gte", "lt", "lte":
		left, ok := assertionNumber(actual.value)
		if !ok {
			return false, got + ", which is not a number"
		}
		right, ok := assertionNumber(parseAssertionExpected(expectedText))
		if !ok {
			return false, fmt.Sprintf("%q is not a number", strings.TrimSpace(expectedText))
		}
		cmp := left.Cmp(right)
		passed := map[string]bool{"gt": cmp > 0, "gte": cmp >= 0, "lt": cmp < 0, "lte": cmp <= 0}[operator]
		return passed, got
	case "in", "notIn":
		found := false
		for _, item := range assertionList(expectedText) {
			if assertionEqualValue(actual.value, item) {
				found = true
				break
			}
		}
		return found == (operator == "in"), got
	case "contains", "notContains":
		found := assertionContains(actual.value, expectedText)
		return found == (operator == "contains"), got
	case "matches":
		pattern, err := regexp.Compile(strings.TrimSpace(expectedText))
		if err != nil {
			return false, "invalid regular expression: " + err.Error()
		}
		return pattern.MatchString(assertionText(actual.value)), got
	case "type":
		want := strings.ToLower(strings.TrimSpace(expectedText))
		have := assertionType(actual.value)
		return have == want, "got " + have
	case "length":
		length, ok := assertionLength(actual.value)
		if !ok {
			return false, got + ", which has no length"
		}
		want, err := strconv.Atoi(strings.TrimSpace(expectedText))
		if err != nil {
			return false, fmt.Sprintf("%q is not a whole number", strings.TrimSpace(expectedText))
		}
		return length == want, fmt.Sprintf("got length %d", length)
	}
	return false, "unknown operator " + operator
}

func assertionEqual(actual any, expectedText string) bool {
	if text, ok := actual.(string); ok {
		expected := parseAssertionExpected(expectedText)
		if quoted, ok := expected.(string); ok {
			return text == quoted
		}
		return text == strings.TrimSpace(expectedText)
	}
	return assertionEqualValue(actual, parseAssertionExpected(expectedText))
}

func assertionEqualValue(actual, expected any) bool {
	if left, ok := assertionNumber(actual); ok {
		if right, ok := assertionNumber(expected); ok {
			return left.Cmp(right) == 0
		}
	}
	if text, ok := actual.(string); ok {
		return text == assertionText(expected)
	}
	return reflect.DeepEqual(normalizeAssertionValue(actual), normalizeAssertionValue(expected))
}

func normalizeAssertionValue(value any) any {
	var buf bytes.Buffer
	encoder := json.NewEncoder(&buf)
	if err := encoder.Encode(value); err != nil {
		return value
	}
	var out any
	_ = json.Unmarshal(buf.Bytes(), &out)
	return out
}

func assertionNumber(value any) (*big.Rat, bool) {
	var text string
	switch v := value.(type) {
	case json.Number:
		text = v.String()
	case string:
		text = strings.TrimSpace(v)
	case float64:
		text = strconv.FormatFloat(v, 'g', -1, 64)
	case int:
		text = strconv.Itoa(v)
	default:
		return nil, false
	}
	rat, ok := new(big.Rat).SetString(text)
	return rat, ok
}

func assertionContains(actual any, expectedText string) bool {
	switch v := actual.(type) {
	case []any:
		expected := parseAssertionExpected(expectedText)
		for _, item := range v {
			if assertionEqualValue(item, expected) {
				return true
			}
		}
		return false
	case map[string]any:
		_, ok := v[strings.TrimSpace(expectedText)]
		return ok
	default:
		return strings.Contains(assertionText(actual), expectedText)
	}
}

func assertionText(value any) string {
	switch v := value.(type) {
	case string:
		return v
	case json.Number:
		return v.String()
	case nil:
		return "null"
	default:
		data, err := json.Marshal(v)
		if err != nil {
			return fmt.Sprint(v)
		}
		return string(data)
	}
}

func assertionType(value any) string {
	switch value.(type) {
	case nil:
		return "null"
	case string:
		return "string"
	case json.Number, float64, int:
		return "number"
	case bool:
		return "boolean"
	case []any:
		return "array"
	case map[string]any:
		return "object"
	default:
		return "unknown"
	}
}

func assertionLength(value any) (int, bool) {
	switch v := value.(type) {
	case string:
		return utf8.RuneCountInString(v), true
	case []any:
		return len(v), true
	case map[string]any:
		return len(v), true
	default:
		return 0, false
	}
}

func describeAssertionValue(value any) string {
	text := assertionText(value)
	if _, ok := value.(string); ok {
		text = strconv.Quote(text)
	}
	if utf8.RuneCountInString(text) > 120 {
		text = string([]rune(text)[:120]) + "…"
	}
	return text
}
