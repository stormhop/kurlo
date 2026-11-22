package api

import (
	"net/url"
	"strings"
)

type docsEnvironment struct {
	ID, Name    string
	Definitions []*docsVariableDefinition
}

type docsVariableDefinition struct {
	Name                    string
	Scope, Source, SourceID string
	EnvironmentID           string
	Position                int
	Value, Description      string
	Masked, Disabled        bool
}

type docsVariable struct {
	Definitions []*docsVariableDefinition
	Uses        []docsLink
}

type docsVariables map[string]*docsVariable

func (vars docsVariables) variable(name string) *docsVariable {
	if vars[name] == nil {
		vars[name] = &docsVariable{}
	}
	return vars[name]
}

func (vars docsVariables) addDefinitions(rows []cliKV, source docsVariableDefinition, credentials map[string]bool) []*docsVariableDefinition {
	var added []*docsVariableDefinition
	for i, row := range rows {
		name := strings.TrimSpace(row.Key)
		if name == "" {
			continue
		}
		definition := source
		definition.Name = name
		definition.Position = i
		definition.Disabled = !row.Enabled
		definition.Description = row.Description
		definition.Masked = source.Masked || row.Secret || docsSensitive(name) || sensitiveDocsVariableValue(row.Value)
		if definition.Masked {
			collectDocsVariables(credentials, row.Value)
		} else {
			definition.Value = docsBody(row.Value, credentials)
		}
		v := vars.variable(name)
		v.Definitions = append(v.Definitions, &definition)
		added = append(added, &definition)
	}
	return added
}

func sensitiveDocsVariableValue(raw string) bool {
	if strings.Contains(raw, kurloSecretPrefix) {
		return true
	}
	value, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || value.Host == "" {
		return false
	}
	if value.User != nil {
		return true
	}
	for key := range value.Query() {
		if docsSensitive(key) {
			return true
		}
	}
	return false
}

func (vars docsVariables) keepReferenced(keep map[string]bool) {
	queue := make([]string, 0, len(keep))
	for name := range keep {
		queue = append(queue, name)
	}
	for len(queue) > 0 {
		name := queue[len(queue)-1]
		queue = queue[:len(queue)-1]
		dependencies := map[string]bool{}
		for _, def := range vars.variable(name).Definitions {
			collectDocsVariables(dependencies, def.Value)
		}
		for key := range dependencies {
			if !keep[key] {
				keep[key] = true
				queue = append(queue, key)
			}
		}
	}
	for key := range vars {
		if !keep[key] {
			delete(vars, key)
		}
	}
}

func (vars docsVariables) maskCredentials(names map[string]bool) {
	for len(names) > 0 {
		for name := range names {
			delete(names, name)
			if v := vars[name]; v != nil {
				for _, def := range v.Definitions {
					collectDocsVariables(names, def.Value)
					def.Value, def.Masked = "", true
				}
			}
		}
	}
}

func docsAuthCredentials(auth cliAuth) []string {
	switch auth.Type {
	case "bearer":
		return []string{auth.BearerToken}
	case "basic", "digest", "ntlm":
		return []string{auth.BasicPass}
	case "apikey":
		return []string{auth.APIKeyValue}
	case "jwt":
		return []string{auth.JWTSecret, auth.JWTPrivateKey}
	case "oauth2":
		return []string{auth.OAuth2Secret, auth.OAuth2Token, auth.OAuth2RefreshToken, auth.OAuth2Password, auth.OAuth2AssertionPrivateKey}
	case "oauth1":
		return []string{auth.OAuth1ConsumerSecret, auth.OAuth1Token, auth.OAuth1TokenSecret, auth.OAuth1PrivateKey}
	case "aws":
		return []string{auth.AWSAccessKey, auth.AWSSecretKey, auth.AWSSessionToken}
	default:
		return nil
	}
}

func credentialVariableNames(names map[string]bool, rows []cliKV, uses map[string]bool) {
	for _, row := range rows {
		if row.Enabled && (row.Secret || docsSensitive(row.Key)) {
			collectDocsVariables(names, row.Value)
			if uses != nil {
				collectDocsVariables(uses, row.Value)
			}
		}
	}
}

type docsBinding struct {
	docsLink
	Order int
}

type docsDefinitionGroup struct {
	*docsVariableDefinition
	Bindings []docsBinding
}

func (v *docsVariable) Groups() []*docsDefinitionGroup {
	var groups []*docsDefinitionGroup
	byValue := map[docsVariableDefinition]*docsDefinitionGroup{}
	for _, definition := range v.Definitions {
		key := *definition
		key.Position = 0
		if key.Scope == "Request" {
			key.Source, key.SourceID = "", ""
		}
		group := byValue[key]
		if group == nil {
			group = &docsDefinitionGroup{docsVariableDefinition: definition}
			groups = append(groups, group)
			byValue[key] = group
		}
		group.Bindings = append(group.Bindings, docsBinding{docsLink{definition.SourceID, definition.Source}, definition.Position})
	}
	return groups
}
