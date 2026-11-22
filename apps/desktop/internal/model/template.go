package model

import "strings"

const VaultTemplatePrefix = "vault:"

func TemplateVariableKey(raw string) string {
	key := strings.TrimSpace(raw)
	if strings.HasPrefix(key, VaultTemplatePrefix) {
		return strings.TrimSpace(key[len(VaultTemplatePrefix):])
	}
	return key
}
