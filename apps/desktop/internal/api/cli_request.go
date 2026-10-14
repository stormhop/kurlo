package api

import (
	"encoding/json"
	"strings"

	"github.com/stormhop/kurlo/apps/desktop/internal/model"
)

type cliKV struct {
	Key      string `json:"key"`
	Value    string `json:"value"`
	Enabled  bool   `json:"enabled"`
	IsFile   bool   `json:"isFile"`
	FileName string `json:"fileName"`
	Secret   bool   `json:"secret"`

	ContentType string `json:"contentType"`
}

type cliAuth struct {
	Type        string `json:"type"`
	BearerToken string `json:"bearerToken"`
	BasicUser   string `json:"basicUser"`
	BasicPass   string `json:"basicPass"`
	APIKeyName  string `json:"apiKeyName"`
	APIKeyValue string `json:"apiKeyValue"`
	APIKeyIn    string `json:"apiKeyIn"`

	OAuth2GrantType           string `json:"oauth2GrantType"`
	OAuth2Token               string `json:"oauth2Token"`
	OAuth2TokenURL            string `json:"oauth2TokenURL"`
	OAuth2AuthURL             string `json:"oauth2AuthURL"`
	OAuth2DeviceAuthURL       string `json:"oauth2DeviceAuthURL"`
	OAuth2ClientID            string `json:"oauth2ClientID"`
	OAuth2Secret              string `json:"oauth2Secret"`
	OAuth2Scope               string `json:"oauth2Scope"`
	OAuth2Audience            string `json:"oauth2Audience"`
	OAuth2RefreshToken        string `json:"oauth2RefreshToken"`
	OAuth2Username            string `json:"oauth2Username"`
	OAuth2Password            string `json:"oauth2Password"`
	OAuth2ClientAuth          string `json:"oauth2ClientAuth"`
	OAuth2AssertionAlgorithm  string `json:"oauth2AssertionAlgorithm"`
	OAuth2AssertionPrivateKey string `json:"oauth2AssertionPrivateKey"`
	OAuth2AssertionKeyID      string `json:"oauth2AssertionKeyID"`
	OAuth2AssertionAudience   string `json:"oauth2AssertionAudience"`

	AWSAccessKey    string `json:"awsAccessKey"`
	AWSSecretKey    string `json:"awsSecretKey"`
	AWSSessionToken string `json:"awsSessionToken"`
	AWSRegion       string `json:"awsRegion"`
	AWSService      string `json:"awsService"`
}

type cliSettings struct {
	HTTPVersion            string `json:"httpVersion"`
	EnableSSLVerification  *bool  `json:"enableSSLVerification"`
	FollowRedirects        *bool  `json:"followRedirects"`
	FollowOriginalMethod   bool   `json:"followOriginalMethod"`
	EncodeURLAutomatically *bool  `json:"encodeUrlAutomatically"`
	DisableCookieJar       bool   `json:"disableCookieJar"`
	MaxRedirects           int    `json:"maxRedirects"`
	TimeoutMs              *int   `json:"timeoutMs"`
	ScriptTimeoutMs        int    `json:"scriptTimeoutMs"`
	AllowSendRequest       bool   `json:"allowSendRequest"`
	ProxyURL               string `json:"proxyUrl"`
	ClientCertPath         string `json:"clientCertPath"`
	ClientKeyPath          string `json:"clientKeyPath"`
	ClientKeyPassword      string `json:"clientKeyPassword"`
	BrowserEmulation       bool   `json:"browserEmulation"`
	BrowserOrigin          string `json:"browserOrigin"`
	BrowserWithCredentials bool   `json:"browserWithCredentials"`
	BrowserEnforceCORS     bool   `json:"browserEnforceCORS"`
	BrowserEnforceCSP      bool   `json:"browserEnforceCSP"`
	BrowserCSP             string `json:"browserCSP"`
}

type cliExampleResponse struct {
	StatusCode    int     `json:"statusCode"`
	Status        string  `json:"status"`
	Headers       []cliKV `json:"headers"`
	Body          string  `json:"body"`
	BodyMediaType string  `json:"bodyMediaType"`
}

type cliExample struct {
	ID       string             `json:"id"`
	Name     string             `json:"name"`
	Source   string             `json:"source"`
	Notes    string             `json:"notes"`
	Response cliExampleResponse `json:"response"`
}

type cliSavedRequest struct {
	ID                 string          `json:"id"`
	Name               string          `json:"name"`
	RequestType        string          `json:"requestType"`
	CollectionID       string          `json:"collectionId"`
	Collection         string          `json:"collection"`
	FolderPath         []string        `json:"folderPath"`
	Method             string          `json:"method"`
	URL                string          `json:"url"`
	IsDraft            bool            `json:"isDraft"`
	Params             []cliKV         `json:"params"`
	Headers            []cliKV         `json:"headers"`
	Auth               cliAuth         `json:"auth"`
	BodyType           string          `json:"bodyType"`
	RawBodyType        string          `json:"rawBodyType"`
	BodyContent        string          `json:"bodyContent"`
	BodyFilePath       string          `json:"bodyFilePath"`
	FormRows           []cliKV         `json:"formRows"`
	PreRequestScript   string          `json:"preRequestScript"`
	TestScript         string          `json:"testScript"`
	PreRequestScriptJs string          `json:"preRequestScriptJs"`
	TestScriptJs       string          `json:"testScriptJs"`
	Settings           cliSettings     `json:"settings"`
	SettingsOverrides  map[string]bool `json:"settingsOverrides"`
	Examples           []cliExample    `json:"examples"`
}

type cliCollectionDefaults struct {
	Variables          []cliKV     `json:"variables"`
	Headers            []cliKV     `json:"headers"`
	Auth               cliAuth     `json:"auth"`
	PreRequestScript   string      `json:"preRequestScript"`
	TestScript         string      `json:"testScript"`
	PreRequestScriptJs string      `json:"preRequestScriptJs"`
	TestScriptJs       string      `json:"testScriptJs"`
	Settings           cliSettings `json:"settings"`
}

type cliCollection struct {
	ID       string                `json:"id"`
	Name     string                `json:"name"`
	Defaults cliCollectionDefaults `json:"defaults"`
}

type cliEnvironment struct {
	ID        string  `json:"id"`
	Name      string  `json:"name"`
	Protected bool    `json:"protected"`
	Values    []cliKV `json:"values"`
}

func decodeMaps[T any](maps []map[string]any) ([]T, error) {
	out := make([]T, 0, len(maps))
	for _, m := range maps {
		raw, err := json.Marshal(m)
		if err != nil {
			return nil, err
		}
		var value T
		if err := json.Unmarshal(raw, &value); err != nil {
			return nil, err
		}
		out = append(out, value)
	}
	return out, nil
}

func boolOr(ptr *bool, fallback bool) bool {
	if ptr == nil {
		return fallback
	}
	return *ptr
}

func enabledRowValues(rows []cliKV) map[string]string {
	values := make(map[string]string)
	for _, row := range rows {
		if row.Enabled && strings.TrimSpace(row.Key) != "" {
			values[strings.TrimSpace(row.Key)] = row.Value
		}
	}
	return values
}

func cliRunnable(req cliSavedRequest) bool {
	switch strings.ToLower(strings.TrimSpace(req.RequestType)) {
	case "", "http", "graphql":
		return !req.IsDraft
	default:
		return false
	}
}

func isGraphQLRequest(req cliSavedRequest) bool {
	return strings.EqualFold(req.RequestType, "graphql") || req.BodyType == "graphql"
}

const defaultCLIRequestTimeoutMs = 30000

func buildHTTPRequest(req cliSavedRequest, values map[string]string, secretValues []string, timeoutOverrideMs int) model.HttpRequest {
	graphql := isGraphQLRequest(req)

	method := strings.ToUpper(strings.TrimSpace(req.Method))
	if graphql || method == "" {
		if graphql {
			method = "POST"
		} else {
			method = "GET"
		}
	}

	params := make([]model.KeyValue, 0, len(req.Params))
	for _, p := range req.Params {
		if p.Enabled && strings.TrimSpace(p.Key) != "" {
			params = append(params, model.KeyValue{Key: p.Key, Value: p.Value, Enabled: true})
		}
	}
	headers := make([]model.KeyValue, 0, len(req.Headers))
	for _, h := range req.Headers {
		if h.Enabled && strings.TrimSpace(h.Key) != "" {
			headers = append(headers, model.KeyValue{Key: h.Key, Value: h.Value, Enabled: true})
		}
	}
	formData := make([]model.KeyValue, 0, len(req.FormRows))
	for _, f := range req.FormRows {
		if f.Enabled && strings.TrimSpace(f.Key) != "" {
			formData = append(formData, model.KeyValue{Key: f.Key, Value: f.Value, Enabled: true, IsFile: f.IsFile, FileName: f.FileName, ContentType: f.ContentType})
		}
	}

	bodyType := req.BodyType
	body := req.BodyContent
	if graphql {
		bodyType = "graphql"
	}

	token := req.Auth.BearerToken
	if req.Auth.Type == "oauth2" {
		token = req.Auth.OAuth2Token
	}

	timeoutMs := defaultCLIRequestTimeoutMs
	if req.Settings.TimeoutMs != nil {
		timeoutMs = *req.Settings.TimeoutMs
	}
	if timeoutOverrideMs > 0 {
		timeoutMs = timeoutOverrideMs
	}

	return model.HttpRequest{
		RequestID: req.ID,
		Method:    method,
		URL:       strings.TrimSpace(req.URL),
		Params:    params,
		Headers:   headers,
		Auth: model.AuthConfig{
			Type:                      req.Auth.Type,
			Token:                     token,
			Username:                  req.Auth.BasicUser,
			Password:                  req.Auth.BasicPass,
			KeyName:                   req.Auth.APIKeyName,
			KeyValue:                  req.Auth.APIKeyValue,
			KeyIn:                     req.Auth.APIKeyIn,
			OAuth2GrantType:           req.Auth.OAuth2GrantType,
			OAuth2TokenURL:            req.Auth.OAuth2TokenURL,
			OAuth2AuthURL:             req.Auth.OAuth2AuthURL,
			OAuth2DeviceAuthURL:       req.Auth.OAuth2DeviceAuthURL,
			OAuth2ClientID:            req.Auth.OAuth2ClientID,
			OAuth2Secret:              req.Auth.OAuth2Secret,
			OAuth2Scope:               req.Auth.OAuth2Scope,
			OAuth2Audience:            req.Auth.OAuth2Audience,
			OAuth2RefreshToken:        req.Auth.OAuth2RefreshToken,
			OAuth2Username:            req.Auth.OAuth2Username,
			OAuth2Password:            req.Auth.OAuth2Password,
			OAuth2ClientAuth:          req.Auth.OAuth2ClientAuth,
			OAuth2AssertionAlgorithm:  req.Auth.OAuth2AssertionAlgorithm,
			OAuth2AssertionPrivateKey: req.Auth.OAuth2AssertionPrivateKey,
			OAuth2AssertionKeyID:      req.Auth.OAuth2AssertionKeyID,
			OAuth2AssertionAudience:   req.Auth.OAuth2AssertionAudience,
			AWSAccessKey:              req.Auth.AWSAccessKey,
			AWSSecretKey:              req.Auth.AWSSecretKey,
			AWSSessionToken:           req.Auth.AWSSessionToken,
			AWSRegion:                 req.Auth.AWSRegion,
			AWSService:                req.Auth.AWSService,
		},
		BodyType:                bodyType,
		Body:                    body,
		BodyFilePath:            req.BodyFilePath,
		FormData:                formData,
		PreRequestScript:        cliPreScript(req),
		TestScript:              cliTestScript(req),
		ScriptEngine:            cliScriptEngine(req),
		FollowRedirects:         boolOr(req.Settings.FollowRedirects, true),
		TimeoutMs:               timeoutMs,
		HTTPVersion:             defaultString(req.Settings.HTTPVersion, "auto"),
		EnableSSLVerification:   boolOr(req.Settings.EnableSSLVerification, true),
		FollowOriginalMethod:    req.Settings.FollowOriginalMethod,
		EncodeURLAutomatically:  boolOr(req.Settings.EncodeURLAutomatically, true),
		DisableCookieJar:        req.Settings.DisableCookieJar,
		MaxRedirects:            req.Settings.MaxRedirects,
		ProxyURL:                req.Settings.ProxyURL,
		ClientCertPath:          req.Settings.ClientCertPath,
		ClientKeyPath:           req.Settings.ClientKeyPath,
		ClientKeyPassword:       req.Settings.ClientKeyPassword,
		BrowserEmulation:        req.Settings.BrowserEmulation,
		BrowserOrigin:           strings.TrimSpace(req.Settings.BrowserOrigin),
		BrowserWithCredentials:  req.Settings.BrowserWithCredentials,
		BrowserEnforceCORS:      req.Settings.BrowserEnforceCORS,
		BrowserEnforceCSP:       req.Settings.BrowserEnforceCSP,
		BrowserCSP:              req.Settings.BrowserCSP,
		SecretEnvironmentValues: secretValues,
		ResolveTemplates:        true,
		TemplateValues:          values,
	}
}

func cliScriptEngine(req cliSavedRequest) string {
	if strings.TrimSpace(req.PreRequestScriptJs) != "" || strings.TrimSpace(req.TestScriptJs) != "" {
		return "js"
	}
	if strings.TrimSpace(req.PreRequestScript) != "" || strings.TrimSpace(req.TestScript) != "" {
		return "tengo"
	}
	return "js"
}

func cliPreScript(req cliSavedRequest) string {
	if cliScriptEngine(req) == "js" {
		return req.PreRequestScriptJs
	}
	return req.PreRequestScript
}

func cliTestScript(req cliSavedRequest) string {
	if cliScriptEngine(req) == "js" {
		return req.TestScriptJs
	}
	return req.TestScript
}

func defaultString(value, fallback string) string {
	if strings.TrimSpace(value) == "" {
		return fallback
	}
	return value
}
