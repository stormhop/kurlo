package api

import (
	"bytes"
	"encoding/json"
	"errors"
	"regexp"
	"sort"
	"strings"

	"github.com/stormhop/kurlo/apps/desktop/internal/model"
	"github.com/stormhop/kurlo/apps/desktop/internal/script"
)

var templatePattern = regexp.MustCompile(`\{\{([^{}]*)\}\}`)

const templateResolutionDepth = 20

func resolveTemplateValue(value string, values map[string]string) string {
	if !strings.Contains(value, "{{") {
		return value
	}
	resolved := substituteTemplates(value, values)
	for depth := 1; depth < templateResolutionDepth && strings.Contains(resolved, "{{"); depth++ {
		next := substituteTemplates(resolved, values)
		if next == resolved {
			break
		}
		resolved = next
	}
	return resolved
}

func substituteTemplates(value string, values map[string]string) string {
	return templatePattern.ReplaceAllStringFunc(value, func(match string) string {
		key := strings.TrimSpace(match[2 : len(match)-2])
		if key == "" {
			return match
		}
		if replacement, ok := values[key]; ok {
			return replacement
		}
		if replacement, ok := resolveDynamicCLIVariable(key); ok {
			return replacement
		}
		return match
	})
}

func resolveTemplateRows(rows []model.KeyValue, values map[string]string) []model.KeyValue {
	if rows == nil {
		return nil
	}
	out := make([]model.KeyValue, len(rows))
	for i, row := range rows {
		row.Key = resolveTemplateValue(row.Key, values)
		row.Value = resolveTemplateValue(row.Value, values)
		out[i] = row
	}
	return out
}

func resolveAuthTemplates(cfg model.AuthConfig, values map[string]string) model.AuthConfig {
	resolve := func(value string) string { return resolveTemplateValue(value, values) }
	cfg.Token = resolve(cfg.Token)
	cfg.Username = resolve(cfg.Username)
	cfg.Password = resolve(cfg.Password)
	cfg.KeyName = resolve(cfg.KeyName)
	cfg.KeyValue = resolve(cfg.KeyValue)
	cfg.OAuth2TokenURL = resolve(cfg.OAuth2TokenURL)
	cfg.OAuth2AuthURL = resolve(cfg.OAuth2AuthURL)
	cfg.OAuth2DeviceAuthURL = resolve(cfg.OAuth2DeviceAuthURL)
	cfg.OAuth2RedirectURL = resolve(cfg.OAuth2RedirectURL)
	cfg.OAuth2ClientID = resolve(cfg.OAuth2ClientID)
	cfg.OAuth2Secret = resolve(cfg.OAuth2Secret)
	cfg.OAuth2Scope = resolve(cfg.OAuth2Scope)
	cfg.OAuth2Audience = resolve(cfg.OAuth2Audience)
	cfg.OAuth2RefreshToken = resolve(cfg.OAuth2RefreshToken)
	cfg.OAuth2Username = resolve(cfg.OAuth2Username)
	cfg.OAuth2Password = resolve(cfg.OAuth2Password)
	cfg.OAuth2AssertionPrivateKey = resolve(cfg.OAuth2AssertionPrivateKey)
	cfg.OAuth2AssertionKeyID = resolve(cfg.OAuth2AssertionKeyID)
	cfg.OAuth2AssertionAudience = resolve(cfg.OAuth2AssertionAudience)
	cfg.AWSAccessKey = resolve(cfg.AWSAccessKey)
	cfg.AWSSecretKey = resolve(cfg.AWSSecretKey)
	cfg.AWSSessionToken = resolve(cfg.AWSSessionToken)
	cfg.AWSRegion = resolve(cfg.AWSRegion)
	cfg.AWSService = resolve(cfg.AWSService)
	cfg.OAuth1ConsumerKey = resolve(cfg.OAuth1ConsumerKey)
	cfg.OAuth1ConsumerSecret = resolve(cfg.OAuth1ConsumerSecret)
	cfg.OAuth1Token = resolve(cfg.OAuth1Token)
	cfg.OAuth1TokenSecret = resolve(cfg.OAuth1TokenSecret)
	cfg.OAuth1PrivateKey = resolve(cfg.OAuth1PrivateKey)
	cfg.OAuth1Realm = resolve(cfg.OAuth1Realm)
	cfg.OAuth1Callback = resolve(cfg.OAuth1Callback)
	cfg.OAuth1Verifier = resolve(cfg.OAuth1Verifier)
	cfg.OAuth1Timestamp = resolve(cfg.OAuth1Timestamp)
	cfg.OAuth1Nonce = resolve(cfg.OAuth1Nonce)
	cfg.OAuth1Version = resolve(cfg.OAuth1Version)
	return cfg
}

func resolveHTTPRequestTemplates(req model.HttpRequest, values map[string]string) (model.HttpRequest, error) {
	resolve := func(value string) string { return resolveTemplateValue(value, values) }
	out := req
	out.URL = resolve(req.URL)
	out.Params = resolveTemplateRows(req.Params, values)
	out.PathParams = resolveTemplateRows(req.PathParams, values)
	out.Headers = resolveTemplateRows(req.Headers, values)
	out.FormData = resolveTemplateRows(req.FormData, values)
	out.Auth = resolveAuthTemplates(req.Auth, values)
	out.BodyFilePath = resolve(req.BodyFilePath)
	out.ProxyURL = resolve(req.ProxyURL)
	out.ClientCertPath = resolve(req.ClientCertPath)
	out.ClientKeyPath = resolve(req.ClientKeyPath)
	out.ClientKeyPassword = resolve(req.ClientKeyPassword)
	if req.GraphQL != nil {
		body, err := buildGraphQLRequestBody(model.GraphQLPayload{
			Query:         resolve(req.GraphQL.Query),
			Variables:     resolve(req.GraphQL.Variables),
			OperationName: resolve(req.GraphQL.OperationName),
		})
		if err != nil {
			return req, err
		}
		out.Body = body
		out.BodyType = "graphql"
	} else {
		out.Body = resolve(req.Body)
		if _, raw := rawBodyContentTypes[out.BodyType]; raw && strings.TrimSpace(out.Body) == "" {
			out.BodyType = "none"
			out.Body = ""
		}
	}
	out.GraphQL = nil
	out.ResolveTemplates = false
	out.TemplateValues = nil
	return out, nil
}

func buildGraphQLRequestBody(payload model.GraphQLPayload) (string, error) {
	query := strings.TrimSpace(payload.Query)
	if query == "" {
		return "", errors.New("GraphQL query is empty")
	}
	variables := json.RawMessage(`{}`)
	if source := strings.TrimSpace(payload.Variables); source != "" {
		if !strings.HasPrefix(source, "{") || !json.Valid([]byte(source)) {
			return "", errors.New("GraphQL variables must be a JSON object")
		}
		var compact bytes.Buffer
		if err := json.Compact(&compact, []byte(source)); err != nil {
			return "", errors.New("GraphQL variables must be a JSON object")
		}
		variables = compact.Bytes()
	}
	body := struct {
		Query         string          `json:"query"`
		Variables     json.RawMessage `json:"variables"`
		OperationName string          `json:"operationName,omitempty"`
	}{Query: query, Variables: variables, OperationName: strings.TrimSpace(payload.OperationName)}
	var out bytes.Buffer
	encoder := json.NewEncoder(&out)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(body); err != nil {
		return "", err
	}
	return strings.TrimSuffix(out.String(), "\n"), nil
}

func scriptVariableChanges(scope *scriptStateScope, collectionBefore map[string]string) []string {
	changed := map[string]struct{}{}
	collect := func(before, after map[string]string) {
		for key, value := range after {
			if previous, ok := before[key]; !ok || previous != value {
				changed[key] = struct{}{}
			}
		}
		for key := range before {
			if _, ok := after[key]; !ok {
				changed[key] = struct{}{}
			}
		}
	}
	collect(scope.beforeVars, scope.ctx.Variables)
	collect(scope.beforeEnv, scope.ctx.Environment)
	collect(collectionBefore, scope.ctx.CollectionVariables)
	keys := make([]string, 0, len(changed))
	for key := range changed {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

func overlayScriptVariables(values map[string]string, ctx *script.Context, keys []string) map[string]string {
	next := make(map[string]string, len(values)+len(keys))
	for key, value := range values {
		next[key] = value
	}
	for _, key := range keys {
		if value, ok := ctx.ResolveVariable(key); ok {
			next[key] = value
		} else {
			delete(next, key)
		}
	}
	return next
}

func revealedSecretValues(keys []string, secretKeys []string, values map[string]string) []string {
	if len(secretKeys) == 0 {
		return nil
	}
	secret := make(map[string]struct{}, len(secretKeys))
	for _, key := range secretKeys {
		secret[key] = struct{}{}
	}
	var out []string
	for _, key := range keys {
		if _, ok := secret[key]; !ok {
			continue
		}
		if value := values[key]; value != "" {
			out = append(out, value)
		}
	}
	return out
}
