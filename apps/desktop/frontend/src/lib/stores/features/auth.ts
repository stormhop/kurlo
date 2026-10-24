import { authorizeOAuth2 as requestOAuth2Authorize, authorizeOAuth2Device as requestOAuth2Device, fetchOAuth2Token as requestOAuth2Token, refreshOAuth2Token as requestOAuth2Refresh } from '../../backend';
import { emptyAuthConfig } from '../../wire';
import type { AuthConfig, OAuth2DevicePrompt, OAuth2TokenResponse } from '../../backend';
import { AUTH_OPTIONS } from '../../constants';
import type { AuthType, OAuth2ClientAuth, OAuth2GrantType, RequestType, SavedRequest } from '../../types/models';
import { authForPersistence as resolveAuthForPersistence, authStateHasData as authHasPersistableData, oauth1AuthFields, type OAuth1Fields } from '../../utils';

type AuthHost = {
  activeRequestId: string;
  apiKeyIn: 'header' | 'query';
  apiKeyName: string;
  apiKeyValue: string;
  authMenuOpen: boolean;
  authType: AuthType;
  awsAccessKey: string;
  awsRegion: string;
  awsSecretKey: string;
  awsSessionToken: string;
  awsService: string;
  oauth1: OAuth1Fields;
  basicPass: string;
  basicUser: string;
  bearerToken: string;
  enableSSLVerification: boolean;
  oauth2ClientID: string;
  oauth2Loading: boolean;
  oauth2Scope: string;
  oauth2Secret: string;
  oauth2Token: string;
  oauth2TokenURL: string;
  oauth2GrantType: OAuth2GrantType;
  oauth2AuthURL: string;
  oauth2DeviceAuthURL: string;
  oauth2Audience: string;
  oauth2RefreshToken: string;
  oauth2TokenExpiry: number;
  oauth2UsePKCE: boolean;
  oauth2Username: string;
  oauth2Password: string;
  oauth2ClientAuth: OAuth2ClientAuth;
  oauth2AssertionAlgorithm: string;
  oauth2AssertionPrivateKey: string;
  oauth2AssertionKeyID: string;
  oauth2AssertionAudience: string;
  oauth2DevicePrompt: OAuth2DevicePrompt | null;
  requestType: RequestType;
  requests: SavedRequest[];
  requestsById: Map<string, SavedRequest>;
  collections: import('../../types/models').Collection[];
  savedRequestSnapshots: Map<string, SavedRequest>;
  requestWithCollectionDefaults: (req: SavedRequest) => SavedRequest;
  ensureValidOAuth2TokenForRequest: (req: SavedRequest) => Promise<void>;
  oauth2ConfigForAuthState: (auth: SavedRequest['auth'], values: Record<string, string>, verifySsl: boolean) => AuthConfig;
  collectionForRequest: (req: Pick<SavedRequest, 'collectionId'>) => import('../../types/models').Collection | undefined;
  currentAuthState: () => SavedRequest['auth'];
  oauth2ConfigForRequest: () => AuthConfig;
  applyOAuth2Result: (result: OAuth2TokenResponse) => void;
  openAlertDialog: (title: string, message: string) => Promise<void>;
  resolveTemplate: (value: string, values?: Record<string, string>) => string;
  snapshotActiveRequest: (options?: { forPersistence?: boolean }) => SavedRequest;
  environmentValuesForRequest: (req: Pick<SavedRequest, 'collectionId'>, envValues?: Record<string, string>) => Record<string, string>;
};

function requestOAuth2ForGrant(grant: OAuth2GrantType, cfg: AuthConfig): Promise<OAuth2TokenResponse | null> {
  switch (grant) {
    case 'authorization_code': return requestOAuth2Authorize(cfg);
    case 'device_code': return requestOAuth2Device(cfg);
    default: return requestOAuth2Token(cfg);
  }
}

export const authFeature = {
  authLabel(this: AuthHost, type: AuthType = this.authType) {
    if (this.requestType === 'grpc' && type === 'oauth2') return 'OAuth 2.0';
    return AUTH_OPTIONS.find(o => o.value === type)?.label ?? 'No auth';
  },

  currentAuthState(this: AuthHost): SavedRequest['auth'] {
    return {
      type: this.authType,
      bearerToken: this.bearerToken,
      basicUser: this.basicUser,
      basicPass: this.basicPass,
      apiKeyName: this.apiKeyName,
      apiKeyValue: this.apiKeyValue,
      apiKeyIn: this.apiKeyIn,
      oauth2TokenURL: this.oauth2TokenURL,
      oauth2ClientID: this.oauth2ClientID,
      oauth2Secret: this.oauth2Secret,
      oauth2Scope: this.oauth2Scope,
      oauth2Token: this.oauth2Token,
      oauth2GrantType: this.oauth2GrantType,
      oauth2AuthURL: this.oauth2AuthURL,
      oauth2DeviceAuthURL: this.oauth2DeviceAuthURL,
      oauth2Audience: this.oauth2Audience,
      oauth2RefreshToken: this.oauth2RefreshToken,
      oauth2TokenExpiry: this.oauth2TokenExpiry,
      oauth2UsePKCE: this.oauth2UsePKCE,
      oauth2Username: this.oauth2Username,
      oauth2Password: this.oauth2Password,
      oauth2ClientAuth: this.oauth2ClientAuth,
      oauth2AssertionAlgorithm: this.oauth2AssertionAlgorithm,
      oauth2AssertionPrivateKey: this.oauth2AssertionPrivateKey,
      oauth2AssertionKeyID: this.oauth2AssertionKeyID,
      oauth2AssertionAudience: this.oauth2AssertionAudience,
      awsAccessKey: this.awsAccessKey,
      awsSecretKey: this.awsSecretKey,
      awsSessionToken: this.awsSessionToken,
      awsRegion: this.awsRegion,
      awsService: this.awsService,
      ...oauth1AuthFields(this.oauth1),
    };
  },

  selectAuthType(this: AuthHost, type: AuthType) {
    this.authType = type;
    this.authMenuOpen = false;
  },

  authHasConfig(this: AuthHost) {
    if (this.authType === 'inherit') {
      const auth = this.collectionForRequest(this.snapshotActiveRequest())?.defaults.auth;
      return Boolean(auth && authHasPersistableData(auth, auth.type));
    }
    if (this.authType === 'bearer') return Boolean(this.bearerToken);
    if (this.authType === 'basic' || this.authType === 'digest') return Boolean(this.basicUser || this.basicPass);
    if (this.authType === 'apikey') return Boolean(this.apiKeyName && this.apiKeyValue);
    if (this.authType === 'oauth2') {
      if (this.oauth2Token) return true;
      if (this.oauth2GrantType === 'authorization_code') return Boolean(this.oauth2AuthURL && this.oauth2TokenURL && this.oauth2ClientID);
      if (this.oauth2GrantType === 'device_code') return Boolean(this.oauth2DeviceAuthURL && this.oauth2TokenURL && this.oauth2ClientID);
      if (this.oauth2GrantType === 'password') return Boolean(this.oauth2TokenURL && this.oauth2Username);
      return Boolean(this.oauth2TokenURL && this.oauth2ClientID);
    }
    if (this.authType === 'aws') return Boolean(this.awsAccessKey && this.awsSecretKey && this.awsRegion && this.awsService);
    if (this.authType === 'oauth1') return Boolean(this.oauth1.consumerKey);
    return false;
  },

  authStateHasData(this: AuthHost, auth: SavedRequest['auth'], type: AuthType = auth.type) {
    return authHasPersistableData(auth, type);
  },

  authForPersistence(this: AuthHost, auth: SavedRequest['auth'] = this.currentAuthState()): SavedRequest['auth'] {
    const stored = this.savedRequestSnapshots.get(this.activeRequestId)?.auth ?? this.requestsById.get(this.activeRequestId)?.auth;
    return resolveAuthForPersistence(auth, stored);
  },

  basicAuthPreview(this: AuthHost) {
    try {
      return `Basic ${btoa(`${this.basicUser}:${this.basicPass}`)}`;
    } catch {
      return 'Basic <generated>';
    }
  },

  oauth2ConfigForAuthState(this: AuthHost, auth: SavedRequest['auth'], values: Record<string, string>, verifySsl: boolean): AuthConfig {
    const resolve = (value: string | undefined) => this.resolveTemplate(value ?? '', values);
    return {
      ...emptyAuthConfig(),
      type: 'oauth2',
      token: '',
      username: '',
      password: '',
      keyName: '',
      keyValue: '',
      keyIn: 'header',
      oauth2GrantType: auth.oauth2GrantType ?? '',
      oauth2TokenURL: resolve(auth.oauth2TokenURL),
      oauth2AuthURL: resolve(auth.oauth2AuthURL),
      oauth2DeviceAuthURL: resolve(auth.oauth2DeviceAuthURL),
      oauth2ClientID: resolve(auth.oauth2ClientID),
      oauth2Secret: resolve(auth.oauth2Secret),
      oauth2Scope: resolve(auth.oauth2Scope),
      oauth2Audience: resolve(auth.oauth2Audience),
      oauth2UsePKCE: auth.oauth2UsePKCE ?? false,
      oauth2RefreshToken: auth.oauth2RefreshToken ?? '',
      oauth2InsecureSkipVerify: !verifySsl,
      oauth2Username: resolve(auth.oauth2Username),
      oauth2Password: resolve(auth.oauth2Password),
      oauth2ClientAuth: auth.oauth2ClientAuth ?? '',
      oauth2AssertionAlgorithm: auth.oauth2AssertionAlgorithm ?? '',
      oauth2AssertionPrivateKey: resolve(auth.oauth2AssertionPrivateKey),
      oauth2AssertionKeyID: resolve(auth.oauth2AssertionKeyID),
      oauth2AssertionAudience: resolve(auth.oauth2AssertionAudience),
      awsAccessKey: '',
      awsSecretKey: '',
      awsRegion: '',
      awsService: '',
    };
  },

  oauth2ConfigForRequest(this: AuthHost): AuthConfig {
    const values = this.environmentValuesForRequest(this.snapshotActiveRequest());
    return {
      ...emptyAuthConfig(),
      type: 'oauth2',
      token: '',
      username: '',
      password: '',
      keyName: '',
      keyValue: '',
      keyIn: 'header',
      oauth2GrantType: this.oauth2GrantType,
      oauth2TokenURL: this.resolveTemplate(this.oauth2TokenURL, values),
      oauth2AuthURL: this.resolveTemplate(this.oauth2AuthURL, values),
      oauth2DeviceAuthURL: this.resolveTemplate(this.oauth2DeviceAuthURL, values),
      oauth2ClientID: this.resolveTemplate(this.oauth2ClientID, values),
      oauth2Secret: this.resolveTemplate(this.oauth2Secret, values),
      oauth2Scope: this.resolveTemplate(this.oauth2Scope, values),
      oauth2Audience: this.resolveTemplate(this.oauth2Audience, values),
      oauth2UsePKCE: this.oauth2UsePKCE,
      oauth2RefreshToken: this.oauth2RefreshToken,
      oauth2InsecureSkipVerify: !this.enableSSLVerification,
      oauth2Username: this.resolveTemplate(this.oauth2Username, values),
      oauth2Password: this.resolveTemplate(this.oauth2Password, values),
      oauth2ClientAuth: this.oauth2ClientAuth,
      oauth2AssertionAlgorithm: this.oauth2AssertionAlgorithm,
      oauth2AssertionPrivateKey: this.resolveTemplate(this.oauth2AssertionPrivateKey, values),
      oauth2AssertionKeyID: this.resolveTemplate(this.oauth2AssertionKeyID, values),
      oauth2AssertionAudience: this.resolveTemplate(this.oauth2AssertionAudience, values),
      awsAccessKey: '',
      awsSecretKey: '',
      awsRegion: '',
      awsService: '',
    };
  },

  applyOAuth2Result(this: AuthHost, result: OAuth2TokenResponse) {
    if (!result.access_token) return;
    this.oauth2Token = result.access_token;
    this.bearerToken = result.access_token;
    this.oauth2TokenExpiry = result.expires_in > 0 ? Date.now() + result.expires_in * 1000 : 0;
    if (result.refresh_token) this.oauth2RefreshToken = result.refresh_token;
  },

  async fetchOAuth2Token(this: AuthHost) {
    this.oauth2Loading = true;
    try {
      const cfg = this.oauth2ConfigForRequest();
      if (this.oauth2GrantType === 'device_code') this.oauth2DevicePrompt = null;
      const result = await requestOAuth2ForGrant(this.oauth2GrantType, cfg);
      if (result?.error) void this.openAlertDialog('OAuth2 error', `${result.error}${result.error_description ? ' — ' + result.error_description : ''}`);
      else if (result?.access_token) this.applyOAuth2Result(result);
    } catch (e) {
      void this.openAlertDialog('OAuth2 error', String(e));
    } finally {
      this.oauth2Loading = false;
      this.oauth2DevicePrompt = null;
    }
  },

  async refreshOAuth2Token(this: AuthHost) {
    if (!this.oauth2RefreshToken) return;
    this.oauth2Loading = true;
    try {
      const result = await requestOAuth2Refresh(this.oauth2ConfigForRequest());
      if (result?.error) void this.openAlertDialog('OAuth2 error', `${result.error}${result.error_description ? ' — ' + result.error_description : ''}`);
      else if (result?.access_token) this.applyOAuth2Result(result);
    } catch (e) {
      void this.openAlertDialog('OAuth2 error', String(e));
    } finally {
      this.oauth2Loading = false;
    }
  },

  async ensureValidOAuth2Token(this: AuthHost) {
    if (this.authType === 'inherit') {
      await this.ensureValidOAuth2TokenForRequest(this.snapshotActiveRequest());
      return;
    }
    if (this.authType !== 'oauth2') return;
    if (!oauth2TokenNeedsRefresh(this.oauth2Token, this.oauth2RefreshToken, this.oauth2TokenExpiry)) return;
    try {
      const result = await requestOAuth2Refresh(this.oauth2ConfigForRequest());
      if (result?.access_token) this.applyOAuth2Result(result);
    } catch {
    }
  },

  async ensureValidOAuth2TokenForRequest(this: AuthHost, req: SavedRequest) {
    const effective = this.requestWithCollectionDefaults(req);
    if (effective.auth.type !== 'oauth2') return;
    if (!oauth2TokenNeedsRefresh(effective.auth.oauth2Token, effective.auth.oauth2RefreshToken, effective.auth.oauth2TokenExpiry)) return;

    const inherited = req.auth.type === 'inherit';
    const collection = inherited ? this.collectionForRequest(req) : undefined;
    if (inherited && !collection) return;

    let result: OAuth2TokenResponse | null = null;
    try {
      const values = this.environmentValuesForRequest(req);
      result = await requestOAuth2Refresh(
        this.oauth2ConfigForAuthState(effective.auth, values, effective.settings.enableSSLVerification),
      );
    } catch {
      return;
    }
    if (!result?.access_token) return;

    const refreshed = (auth: SavedRequest['auth']): SavedRequest['auth'] => ({
      ...auth,
      oauth2Token: result.access_token,
      bearerToken: result.access_token,
      oauth2TokenExpiry: result.expires_in > 0 ? Date.now() + result.expires_in * 1000 : 0,
      oauth2RefreshToken: result.refresh_token || auth.oauth2RefreshToken,
    });

    if (inherited && collection) {
      this.collections = this.collections.map(candidate =>
        candidate.id === collection.id
          ? { ...candidate, defaults: { ...candidate.defaults, auth: refreshed(candidate.defaults.auth) } }
          : candidate,
      );
    } else {
      this.requests = this.requests.map(candidate =>
        candidate.id === req.id ? { ...candidate, auth: refreshed(candidate.auth) } : candidate,
      );
    }
    if (req.id === this.activeRequestId && !inherited) this.applyOAuth2Result(result);
  },
};

function oauth2TokenNeedsRefresh(token: string | undefined, refreshToken: string | undefined, expiry: number | undefined): boolean {
  if (!token || !refreshToken || !expiry) return false;
  return Date.now() >= expiry - 30_000;
}
