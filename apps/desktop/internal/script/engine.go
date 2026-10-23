package script

import (
	"regexp"
	"sort"
	"strings"
	"time"

	"github.com/stormhop/kurlo/apps/desktop/internal/model"
)

type Engine string

const (
	EngineTengo Engine = "tengo"
	EngineJS    Engine = "js"
)

var scriptExecutionTimeout = 2 * time.Second

const maxScriptExecutionTimeout = 60 * time.Second

const scriptMaxSourceBytes = 1024 * 1024

func resolveTimeout(override time.Duration) time.Duration {
	if override <= 0 {
		return scriptExecutionTimeout
	}
	if override > maxScriptExecutionTimeout {
		return maxScriptExecutionTimeout
	}
	return override
}

func resolveEngine(name string) Engine {
	switch strings.ToLower(strings.TrimSpace(name)) {
	case "js", "javascript", "node":
		return EngineJS
	default:
		return EngineTengo
	}
}

type Info struct {
	RequestName    string
	Iteration      int
	IterationCount int
}

func PostmanBodyMode(bodyType string) string {
	switch strings.ToLower(strings.TrimSpace(bodyType)) {
	case "urlencoded":
		return "urlencoded"
	case "form":
		return "formdata"
	case "binary":
		return "file"
	case "graphql":
		return "graphql"
	case "", "none":
		return "none"
	default:
		return "raw"
	}
}

type SendFunc func(SendRequest) SendResponse

type Context struct {
	Variables           map[string]string
	Environment         map[string]string
	CollectionVariables map[string]string
	IterationData       map[string]string

	RequestURL     string
	RequestMethod  string
	RequestHeaders map[string]string
	RequestParams  map[string]string

	RequestPathParams map[string]string
	TouchedPathParams map[string]struct{}

	RemovedHeaders map[string]struct{}
	RemovedParams  map[string]struct{}

	TouchedHeaders map[string]struct{}
	TouchedParams  map[string]struct{}

	RequestBody        string
	RequestBodyType    string
	RequestBodyChanged bool

	RequestBodyFilePath string

	RequestFormData        []model.KeyValue
	RequestFormDataChanged bool

	Response *model.HttpResponse

	Cookies []model.Cookie

	Info Info

	Timeout time.Duration

	Send SendFunc

	DynamicVariable func(name string) (string, bool)

	SkipRequest bool

	Tests []model.TestResult
	Logs  []string
}

func NewContext(vars, env map[string]string) *Context {
	if vars == nil {
		vars = make(map[string]string)
	}
	if env == nil {
		env = make(map[string]string)
	}
	return &Context{
		Variables:           vars,
		Environment:         env,
		CollectionVariables: make(map[string]string),
		RequestHeaders:      make(map[string]string),
		RequestParams:       make(map[string]string),
		RemovedHeaders:      make(map[string]struct{}),
		RemovedParams:       make(map[string]struct{}),
		TouchedHeaders:      make(map[string]struct{}),
		TouchedParams:       make(map[string]struct{}),
		RequestPathParams:   make(map[string]string),
		TouchedPathParams:   make(map[string]struct{}),
	}
}

func (c *Context) SetRequestHeader(key, value string) {
	for existing := range c.RequestHeaders {
		if strings.EqualFold(existing, key) {
			delete(c.RequestHeaders, existing)
		}
	}
	c.RequestHeaders[key] = value
	c.TouchedHeaders[strings.ToLower(key)] = struct{}{}
	delete(c.RemovedHeaders, strings.ToLower(key))
}

func (c *Context) UnsetRequestHeader(key string) {
	for existing := range c.RequestHeaders {
		if strings.EqualFold(existing, key) {
			delete(c.RequestHeaders, existing)
		}
	}
	c.TouchedHeaders[strings.ToLower(key)] = struct{}{}
	c.RemovedHeaders[strings.ToLower(key)] = struct{}{}
}

func (c *Context) SetRequestParam(key, value string) {
	c.RequestParams[key] = value
	c.TouchedParams[key] = struct{}{}
	delete(c.RemovedParams, key)
}

func (c *Context) SetRequestPathParam(key, value string) {
	c.RequestPathParams[key] = value
	c.TouchedPathParams[key] = struct{}{}
}

func (c *Context) UnsetRequestParam(key string) {
	delete(c.RequestParams, key)
	c.TouchedParams[key] = struct{}{}
	c.RemovedParams[key] = struct{}{}
}

func (c *Context) ResolveVariable(key string) (string, bool) {
	if v, ok := c.IterationData[key]; ok {
		return v, true
	}
	if v, ok := c.Environment[key]; ok {
		return v, true
	}
	if v, ok := c.CollectionVariables[key]; ok {
		return v, true
	}
	v, ok := c.Variables[key]
	return v, ok
}

var replaceInPattern = regexp.MustCompile(`\{\{([^{}]*)\}\}`)

func (c *Context) ReplaceIn(value string) string {
	substitute := func(input string) string {
		return replaceInPattern.ReplaceAllStringFunc(input, func(match string) string {
			key := strings.TrimSpace(match[2 : len(match)-2])
			if key == "" {
				return match
			}
			if v, ok := c.ResolveVariable(key); ok {
				return v
			}
			if c.DynamicVariable != nil {
				if v, ok := c.DynamicVariable(key); ok {
					return v
				}
			}
			return match
		})
	}
	resolved := value
	for depth := 0; depth < 20 && strings.Contains(resolved, "{{"); depth++ {
		next := substitute(resolved)
		if next == resolved {
			break
		}
		resolved = next
	}
	return resolved
}

func RunPreRequest(engine, src string, ctx *Context) model.ScriptResult {
	return run(engine, src, ctx, false)
}

func RunTests(engine, src string, ctx *Context) model.ScriptResult {
	return run(engine, src, ctx, true)
}

func run(engine, src string, ctx *Context, hasResponse bool) (result model.ScriptResult) {
	if strings.TrimSpace(src) == "" {
		return
	}
	if len(src) > scriptMaxSourceBytes {
		result.Error = "script is too large"
		return
	}

	before := make(map[string]string, len(ctx.CollectionVariables))
	for k, v := range ctx.CollectionVariables {
		before[k] = v
	}

	switch resolveEngine(engine) {
	case EngineJS:
		result.Error = runJS(src, ctx, hasResponse)
	default:
		result.Error = runTengo(src, ctx, hasResponse)
	}

	result.Tests = ctx.Tests
	result.Logs = ctx.Logs
	result.SkippedRequest = ctx.SkipRequest
	result.CollectionVariables, result.CollectionVariablesRemoved = collectionVariableDelta(before, ctx.CollectionVariables)
	return
}

func collectionVariableDelta(before, after map[string]string) (map[string]string, []string) {
	var changed map[string]string
	for key, value := range after {
		if prev, ok := before[key]; !ok || prev != value {
			if changed == nil {
				changed = make(map[string]string)
			}
			changed[key] = value
		}
	}
	var removed []string
	for key := range before {
		if _, ok := after[key]; !ok {
			removed = append(removed, key)
		}
	}
	sort.Strings(removed)
	return changed, removed
}
