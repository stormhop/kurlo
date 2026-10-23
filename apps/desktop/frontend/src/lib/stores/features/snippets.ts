import type { HttpRequest } from '../../backend';
import { collectionSecretVariableKeys } from '../../collectionDefaults';
import type { SnippetRequest } from '../../snippets';
import type { Collection, RenderedSnippetLine, SavedRequest } from '../../types/models';
import { clipboardCopy } from '../../utils';
import { variableTemplate } from '../../variables';
import type { SnippetLanguage } from '../ui';
import { applyPathParams } from '../../pathParams';

type SnippetsHost = {
  copiedSnippet: boolean;
  snippetLanguage: SnippetLanguage;
  snippetTextCache: string;
  snippetRenderedLinesCache: RenderedSnippetLine[];
  snippetRenderKey: string;
  snippetRenderPendingKey: string;
  snippetRenderToken: number;
  buildRequest: (envValues?: Record<string, string>, secretEnvironmentValues?: string[], requestId?: string) => HttpRequest;
  buildSnippetRequest: () => SnippetRequest;
  collectionForRequest: (req: Pick<SavedRequest, 'collectionId'>) => Collection | undefined;
  environmentValuesForRequest: (req: Pick<SavedRequest, 'collectionId'>, envValues?: Record<string, string>) => Record<string, string>;
  redactedActiveEnvironmentValues: () => Record<string, string>;
  snapshotActiveRequest: (options?: { forPersistence?: boolean }) => SavedRequest;
  refreshSnippet: () => Promise<string>;
};

export const snippetsFeature = {
  get snippetText(): string {
    const host = this as unknown as SnippetsHost;
    void host.refreshSnippet();
    return host.snippetTextCache || '// Loading snippet...';
  },

  get snippetRenderedLines(): RenderedSnippetLine[] {
    const host = this as unknown as SnippetsHost;
    void host.refreshSnippet();
    return host.snippetRenderedLinesCache.length
      ? host.snippetRenderedLinesCache
      : [{ number: 1, html: '<span class="snippet-comment">// Loading snippet...</span>' }];
  },

  async refreshSnippet(this: SnippetsHost) {
    let request: SnippetRequest;
    try {
      request = this.buildSnippetRequest();
    } catch (error) {
      const text = `// ${error instanceof Error ? error.message : String(error)}`;
      this.snippetTextCache = text;
      this.snippetRenderedLinesCache = [{ number: 1, html: text.replace(/[&<>]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[ch] ?? ch) }];
      return text;
    }

    const key = JSON.stringify([this.snippetLanguage, request]);
    if (key === this.snippetRenderKey && this.snippetRenderedLinesCache.length) return this.snippetTextCache;
    if (key === this.snippetRenderPendingKey) return this.snippetTextCache;

    this.snippetRenderPendingKey = key;
    const token = ++this.snippetRenderToken;
    try {
      const [{ buildSnippet, renderSnippetLines }, { toCurl }] = await Promise.all([
        import('../../snippets'),
        import('../../curl'),
      ]);
      if (token !== this.snippetRenderToken || key !== this.snippetRenderPendingKey) return this.snippetTextCache;
      const text = buildSnippet(this.snippetLanguage, request, toCurl);
      this.snippetTextCache = text;
      this.snippetRenderedLinesCache = renderSnippetLines(text, this.snippetLanguage);
      this.snippetRenderKey = key;
      return text;
    } catch (error) {
      if (token !== this.snippetRenderToken) return this.snippetTextCache;
      const text = `// ${error instanceof Error ? error.message : String(error)}`;
      this.snippetTextCache = text;
      this.snippetRenderedLinesCache = [{ number: 1, html: text.replace(/[&<>]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[ch] ?? ch) }];
      this.snippetRenderKey = key;
      return text;
    } finally {
      if (token === this.snippetRenderToken) this.snippetRenderPendingKey = '';
    }
  },

  buildSnippetRequest(this: SnippetsHost): SnippetRequest {
    const snapshot = this.snapshotActiveRequest();
    const values = this.environmentValuesForRequest(snapshot, this.redactedActiveEnvironmentValues());
    for (const key of collectionSecretVariableKeys(this.collectionForRequest(snapshot))) values[key] = variableTemplate(key);
    const req = this.buildRequest(values, []);
    return {
      method: req.method,
      url: applyPathParams(req.url, req.pathParams),
      params: req.params,
      headers: req.headers,
      auth: {
        type: req.auth.type,
        token: req.auth.token,
        username: req.auth.username,
        password: req.auth.password,
        keyName: req.auth.keyName,
        keyValue: req.auth.keyValue,
        keyIn: req.auth.keyIn,
        awsAccessKey: req.auth.awsAccessKey,
        awsSecretKey: req.auth.awsSecretKey,
        awsSessionToken: req.auth.awsSessionToken,
        awsRegion: req.auth.awsRegion,
        awsService: req.auth.awsService,
      },
      bodyType: req.bodyType,
      body: req.body,
      bodyFilePath: req.bodyFilePath,
      formData: req.formData,
    };
  },

  async copySnippet(this: SnippetsHost) {
    await this.refreshSnippet();
    await clipboardCopy(this.snippetTextCache);
    this.copiedSnippet = true;
    setTimeout(() => (this.copiedSnippet = false), 1600);
  },
};
