package script

import (
	"cmp"
	"strings"

	"github.com/stormhop/kurlo/apps/desktop/internal/model"
)

func scriptRequestAuth(auth model.AuthConfig) map[string]any {
	kind := strings.ToLower(strings.TrimSpace(auth.Type))
	var values map[string]any
	switch kind {
	case "bearer":
		values = map[string]any{"token": auth.Token}
	case "basic", "digest", "ntlm":
		values = map[string]any{"username": auth.Username, "password": auth.Password}
	case "apikey":
		values = map[string]any{"key": auth.KeyName, "value": auth.KeyValue, "in": auth.KeyIn}
	case "aws":
		kind = "awsv4"
		values = map[string]any{
			"accessKey": auth.AWSAccessKey, "secretKey": auth.AWSSecretKey, "sessionToken": auth.AWSSessionToken,
			"region": auth.AWSRegion, "service": auth.AWSService,
		}
	case "oauth1":
		values = map[string]any{
			"consumerKey": auth.OAuth1ConsumerKey, "consumerSecret": auth.OAuth1ConsumerSecret,
			"token": auth.OAuth1Token, "tokenSecret": auth.OAuth1TokenSecret,
			"signatureMethod": cmp.Or(auth.OAuth1SignatureMethod, "HMAC-SHA1"), "privateKey": auth.OAuth1PrivateKey,
			"realm": auth.OAuth1Realm, "callback": auth.OAuth1Callback, "verifier": auth.OAuth1Verifier,
			"timestamp": auth.OAuth1Timestamp, "nonce": auth.OAuth1Nonce, "version": cmp.Or(auth.OAuth1Version, "1.0"),
			"addParamsToHeader": cmp.Or(auth.OAuth1AddTo, "header") == "header",
			"includeBodyHash":   auth.OAuth1IncludeBodyHash, "addEmptyParamsToSign": auth.OAuth1AddEmptyParams,
		}
	case "oauth2":
		grant := cmp.Or(auth.OAuth2GrantType, "client_credentials")
		switch {
		case grant == "password":
			grant = "password_credentials"
		case grant == "authorization_code" && auth.OAuth2UsePKCE:
			grant = "authorization_code_with_pkce"
		}
		clientAuth := auth.OAuth2ClientAuth
		if clientAuth == "" || clientAuth == "basic" {
			clientAuth = "header"
		}
		values = map[string]any{
			"client_authentication": clientAuth,
			"grant_type":            grant, "accessToken": auth.Token, "refreshToken": auth.OAuth2RefreshToken,
			"clientId": auth.OAuth2ClientID, "clientSecret": auth.OAuth2Secret,
			"accessTokenUrl": auth.OAuth2TokenURL, "authUrl": auth.OAuth2AuthURL,
			"scope": auth.OAuth2Scope, "audience": auth.OAuth2Audience,
			"username": auth.OAuth2Username, "password": auth.OAuth2Password,
		}
	case "jwt":
		addTo := "header"
		if auth.JWTAddTo == "query" {
			addTo = "queryParam"
		}
		values = map[string]any{
			"algorithm": cmp.Or(auth.JWTAlgorithm, "HS256"), "secret": auth.JWTSecret,
			"isSecretBase64Encoded": auth.JWTSecretBase64, "privateKey": auth.JWTPrivateKey,
			"payload": cmp.Or(auth.JWTPayload, "{}"), "header": cmp.Or(auth.JWTHeaders, "{}"),
			"addTokenTo": addTo, "headerPrefix": cmp.Or(auth.JWTHeaderPrefix, "Bearer"),
			"queryParamKey": cmp.Or(auth.JWTQueryParam, "token"),
		}
	default:
		kind = "noauth"
	}
	return map[string]any{"type": kind, "values": values}
}
