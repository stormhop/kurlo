---
title: "Request file"
---

Path: `workspaces/<workspace>/collections/<collection>/requests/<request filesystemName>.yml`

```yaml
version: 1
request:
  id: req-login
  name: Login
  requestType: http
  collectionId: collection-core
  folderPath:
    - Auth
  method: POST
  url: "{{baseUrl}}/login"
  requestTab: body
  params: []
  headers:
    - id: 1
      enabled: true
      key: Content-Type
      value: application/json
      description: ""
  auth:
    type: bearer
    bearerToken: "{{kurloSecret:request:req-login:auth:bearerToken}}"
    basicUser: ""
    basicPass: ""
    apiKeyName: X-API-Key
    apiKeyValue: ""
    apiKeyIn: header
    oauth2GrantType: client_credentials
    oauth2AuthURL: ""
    oauth2TokenURL: ""
    oauth2ClientID: ""
    oauth2Secret: ""
    oauth2Scope: ""
    oauth2Token: ""
    oauth2RefreshToken: ""
    oauth2TokenExpiry: 0
    oauth2UsePKCE: true
    awsAccessKey: ""
    awsSecretKey: ""
    awsRegion: us-east-1
    awsService: execute-api
  bodyType: json
  rawBodyType: json
  bodyContent: |-
    {"username":"ada"}
  bodyFilePath: ""
  bodyFileName: ""
  formRows: []
  graphqlSchema: ""
  preRequestScriptJs: ""
  testScriptJs: ""
  requestNotes: ""
  settings:
    httpVersion: auto
    enableSSLVerification: true
    followRedirects: true
    followOriginalMethod: false
    followAuthorizationHeader: false
    removeRefererHeader: false
    encodeUrlAutomatically: true
    disableCookieJar: false
    maxRedirects: 10
    timeoutMs: 30000
    proxyUrl: ""
    browserEmulation: false
    browserOrigin: ""
    browserWithCredentials: false
    browserEnforceCORS: false
    browserEnforceCSP: false
    browserCSP: ""
    wsHandshakeTimeoutMs: 0
    wsReconnectAttempts: 0
    wsReconnectIntervalMs: 5000
    wsMaxMessageSizeMb: 10
    sioClientVersion: v3
    sioPath: /socket.io
    sioNamespace: /
    grpcUseTls: false
    grpcUseReflection: true
    grpcServerName: ""
    grpcIncludeDefaultValues: true
    grpcMaxResponseMessageSizeMb: 10
  settingsOverrides: {}
  grpcMethod: ""
  grpcMetadata: []
  grpcUseReflection: true
  grpcProtoFilePath: ""
  grpcProtoFileName: ""
  grpcProtoImportPaths: []
```
