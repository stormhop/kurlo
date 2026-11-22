package proxycapture

import (
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"sync"
	"sync/atomic"
)

const maxRules = 200

const (
	RuleLocal   = "local"
	RuleRewrite = "rewrite"
)

type HeaderValue struct {
	Name  string `json:"name"`
	Value string `json:"value"`
}

type LocalAnswer struct {
	Status       int    `json:"status"`
	ContentType  string `json:"contentType"`
	Body         string `json:"body"`
	DelayMs      int    `json:"delayMs"`
	RateKiB      int    `json:"rateKiB"`
	ErrorPercent int    `json:"errorPercent"`
	Pause        bool   `json:"pause"`
	Script       string `json:"script"`
}

type RewriteAction struct {
	Target                string        `json:"target"`
	PathFrom              string        `json:"pathFrom"`
	PathTo                string        `json:"pathTo"`
	SetRequestHeaders     []HeaderValue `json:"setRequestHeaders"`
	RemoveRequestHeaders  []string      `json:"removeRequestHeaders"`
	SetResponseHeaders    []HeaderValue `json:"setResponseHeaders"`
	RemoveResponseHeaders []string      `json:"removeResponseHeaders"`
}

type Rule struct {
	ID      string        `json:"id"`
	Name    string        `json:"name"`
	Enabled bool          `json:"enabled"`
	Kind    string        `json:"kind"`
	Method  string        `json:"method"`
	URL     string        `json:"url"`
	Local   LocalAnswer   `json:"local"`
	Rewrite RewriteAction `json:"rewrite"`
	Hits    int64         `json:"hits"`
}

type compiledRule struct {
	Rule
	pattern   *regexp.Regexp
	withQuery bool
	target    *url.URL
	hits      *atomic.Int64
}

type ruleSet struct {
	mu   sync.RWMutex
	list []*compiledRule
}

var methodPattern = regexp.MustCompile(`^[A-Z]{1,16}$`)
var headerNamePattern = regexp.MustCompile("^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$")

func (s *ruleSet) set(rules []Rule) error {
	if len(rules) > maxRules {
		return fmt.Errorf("keep at most %d rules", maxRules)
	}
	s.mu.RLock()
	previous := map[string]*atomic.Int64{}
	for _, rule := range s.list {
		previous[rule.ID] = rule.hits
	}
	s.mu.RUnlock()
	seen := map[string]bool{}
	compiled := make([]*compiledRule, 0, len(rules))
	for i, rule := range rules {
		item, err := compileRule(rule)
		if err != nil {
			name := strings.TrimSpace(rule.Name)
			if name == "" {
				name = fmt.Sprintf("rule %d", i+1)
			}
			return fmt.Errorf("%s: %w", name, err)
		}
		if seen[item.ID] {
			return fmt.Errorf("rule %q appears twice", item.ID)
		}
		seen[item.ID] = true
		item.hits = previous[item.ID]
		if item.hits == nil {
			item.hits = new(atomic.Int64)
		}
		compiled = append(compiled, item)
	}
	s.mu.Lock()
	s.list = compiled
	s.mu.Unlock()
	return nil
}

func (s *ruleSet) rules() []Rule {
	s.mu.RLock()
	defer s.mu.RUnlock()
	result := make([]Rule, len(s.list))
	for i, item := range s.list {
		result[i] = item.Rule
		result[i].Hits = item.hits.Load()
	}
	return result
}

func (s *ruleSet) enabled() int {
	s.mu.RLock()
	defer s.mu.RUnlock()
	count := 0
	for _, item := range s.list {
		if item.Enabled {
			count++
		}
	}
	return count
}

func (s *ruleSet) matching(kind string, r *http.Request) []*compiledRule {
	s.mu.RLock()
	defer s.mu.RUnlock()
	var result []*compiledRule
	for _, item := range s.list {
		if item.Enabled && item.Kind == kind && item.matches(r) {
			result = append(result, item)
		}
	}
	return result
}

func (c *compiledRule) matches(r *http.Request) bool {
	if c.Method != "" && c.Method != r.Method {
		return false
	}
	return c.pattern.MatchString(matchTarget(r.URL, c.withQuery))
}

func matchTarget(u *url.URL, withQuery bool) string {
	path := u.EscapedPath()
	if path == "" {
		path = "/"
	}
	value := strings.ToLower(u.Scheme) + "://" + strings.ToLower(u.Host) + path
	if withQuery && u.RawQuery != "" {
		value += "?" + u.RawQuery
	}
	return value
}

func compilePattern(raw string) (*regexp.Regexp, bool, error) {
	pattern := strings.TrimSpace(raw)
	if pattern == "" || len(pattern) > 2048 || strings.ContainsAny(pattern, " \t\r\n") {
		return nil, false, errors.New("enter a URL pattern such as https://api.example.com/orders/*")
	}
	scheme, rest, ok := strings.Cut(pattern, "://")
	if !ok {
		return nil, false, errors.New("start the URL pattern with http://, https:// or *://")
	}
	scheme = strings.ToLower(scheme)
	if scheme != "http" && scheme != "https" && scheme != "*" {
		return nil, false, errors.New("start the URL pattern with http://, https:// or *://")
	}
	host, path, hasPath := strings.Cut(rest, "/")
	if host == "" {
		return nil, false, errors.New("add a host to the URL pattern")
	}
	normalized := scheme + "://" + strings.ToLower(host) + "/"
	if hasPath {
		normalized += path
	} else {
		normalized += "*"
	}
	var expression strings.Builder
	expression.WriteString("^")
	for i, part := range strings.Split(normalized, "*") {
		if i > 0 {
			expression.WriteString(".*")
		}
		expression.WriteString(regexp.QuoteMeta(part))
	}
	expression.WriteString("$")
	compiled, err := regexp.Compile(expression.String())
	return compiled, strings.Contains(normalized, "?"), err
}

func compileRule(rule Rule) (*compiledRule, error) {
	rule.ID = strings.TrimSpace(rule.ID)
	rule.Name = strings.TrimSpace(rule.Name)
	rule.Method = strings.ToUpper(strings.TrimSpace(rule.Method))
	rule.URL = strings.TrimSpace(rule.URL)
	if rule.ID == "" || len(rule.ID) > 64 {
		return nil, errors.New("missing rule ID")
	}
	if len(rule.Name) > 120 || strings.ContainsAny(rule.Name, "\r\n") {
		return nil, errors.New("use a name of up to 120 characters")
	}
	if rule.Method != "" && !methodPattern.MatchString(rule.Method) {
		return nil, errors.New("enter an HTTP method such as GET, or leave it empty for any method")
	}
	pattern, withQuery, err := compilePattern(rule.URL)
	if err != nil {
		return nil, err
	}
	item := &compiledRule{Rule: rule, pattern: pattern, withQuery: withQuery}
	switch rule.Kind {
	case RuleLocal:
		item.Rewrite = RewriteAction{}
		err = validateLocal(rule.Local)
	case RuleRewrite:
		item.Local = LocalAnswer{}
		item.target, err = validateRewrite(&item.Rewrite)
	default:
		err = errors.New("choose Map local or Rewrite")
	}
	if err != nil {
		return nil, err
	}
	item.Hits = 0
	return item, nil
}

func validateLocal(answer LocalAnswer) error {
	if answer.Status < 200 || answer.Status > 599 {
		return errors.New("use a status between 200 and 599")
	}
	if answer.DelayMs < 0 || answer.DelayMs > 30000 || answer.RateKiB < 0 || answer.RateKiB > 16384 || answer.ErrorPercent < 0 || answer.ErrorPercent > 100 {
		return errors.New("use a delay up to 30000 ms, a speed up to 16384 KiB/s and an error rate up to 100%")
	}
	if len(answer.Script) > 16<<10 || len(answer.Body) > 1<<20 {
		return errors.New("keep the body under 1 MiB and hooks under 16 KiB")
	}
	if len(answer.ContentType) > 256 || strings.ContainsAny(answer.ContentType, "\r\n") {
		return errors.New("enter a valid Content-Type")
	}
	return nil
}

func validateRewrite(action *RewriteAction) (*url.URL, error) {
	action.Target = strings.TrimRight(strings.TrimSpace(action.Target), "/")
	var target *url.URL
	if action.Target != "" {
		parsed, err := url.Parse(action.Target)
		if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") || parsed.Host == "" || parsed.Path != "" || parsed.RawQuery != "" || parsed.User != nil {
			return nil, errors.New("enter the new destination as http://host:port or https://host")
		}
		target = parsed
	}
	if len(action.PathFrom) > 1024 || len(action.PathTo) > 1024 || strings.ContainsAny(action.PathFrom+action.PathTo, " \r\n?#") {
		return nil, errors.New("enter path parts without spaces, ? or #")
	}
	if action.PathFrom == "" && action.PathTo != "" {
		return nil, errors.New("enter the part of the path to replace")
	}
	for _, headers := range [][]HeaderValue{action.SetRequestHeaders, action.SetResponseHeaders} {
		for _, header := range headers {
			if !headerNamePattern.MatchString(header.Name) || len(header.Value) > 8<<10 || strings.ContainsAny(header.Value, "\r\n\x00") {
				return nil, fmt.Errorf("check the header %q", header.Name)
			}
		}
	}
	for _, names := range [][]string{action.RemoveRequestHeaders, action.RemoveResponseHeaders} {
		for _, name := range names {
			if !headerNamePattern.MatchString(name) {
				return nil, fmt.Errorf("check the header name %q", name)
			}
		}
	}
	if target == nil && action.PathFrom == "" && len(action.SetRequestHeaders)+len(action.RemoveRequestHeaders)+len(action.SetResponseHeaders)+len(action.RemoveResponseHeaders) == 0 {
		return nil, errors.New("add a destination, a path change or a header change")
	}
	return target, nil
}

func applyRequestRewrites(r *http.Request, rules []*compiledRule) {
	next := *r.URL
	for _, rule := range rules {
		action := rule.Rewrite
		if rule.target != nil {
			next.Scheme = rule.target.Scheme
			next.Host = rule.target.Host
		}
		if action.PathFrom != "" && strings.Contains(next.Path, action.PathFrom) {
			next.Path = strings.Replace(next.Path, action.PathFrom, action.PathTo, 1)
			next.RawPath = ""
		}
		for _, name := range action.RemoveRequestHeaders {
			r.Header.Del(name)
		}
		for _, header := range action.SetRequestHeaders {
			r.Header.Set(header.Name, header.Value)
		}
		rule.hits.Add(1)
	}
	r.URL = &next
	r.Host = next.Host
}

func applyResponseRewrites(header http.Header, rules []*compiledRule) {
	for _, rule := range rules {
		for _, name := range rule.Rewrite.RemoveResponseHeaders {
			header.Del(name)
		}
		for _, item := range rule.Rewrite.SetResponseHeaders {
			header.Set(item.Name, item.Value)
		}
	}
}

func ruleNames(rules []*compiledRule) string {
	names := make([]string, 0, len(rules))
	for _, rule := range rules {
		name := rule.Name
		if name == "" {
			name = rule.URL
		}
		names = append(names, name)
	}
	return strings.Join(names, ", ")
}

func (r *Recorder) Rules() []Rule { return r.rules.rules() }

func (r *Recorder) SetRules(rules []Rule) error {
	if err := r.rules.set(rules); err != nil {
		return err
	}
	r.mu.Lock()
	s := r.run
	r.mu.Unlock()
	if s != nil {
		s.changed()
	}
	return nil
}
