import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { CompletionContext } from '@codemirror/autocomplete';
import { javascript } from '@codemirror/lang-javascript';
import { EditorState } from '@codemirror/state';
import { describe, expect, it } from 'vitest';
import { scriptMembers } from '../lib/scriptApi';
import { completeScript, type ScriptScope } from '../lib/scriptCompletion';

function complete(source: string, tests = true) {
  const pos = source.indexOf('|');
  const state = EditorState.create({ doc: source.replace('|', ''), extensions: [javascript()] });
  const names = (scope: ScriptScope) => scope === 'requests' ? ["Login user's account"] : ['baseUrl', 'baseUrl'];
  return completeScript(new CompletionContext(state, pos, true), { tests, names });
}

function labels(source: string, tests = true) {
  return complete(source, tests)?.options.map(item => item.label) ?? [];
}

describe('script completions', () => {
  it('matches the members exposed by the embedded JavaScript runtime', () => {
    const source = readFileSync(new URL('../../../internal/script/engine_javascript.go', import.meta.url), 'utf8');
    const prelude = source.split('const jsPrelude = `')[1].split('\n`')[0];
    const host = {
      hasResponse: true, resHeadersJSON: () => '{}', resBody: () => '', resCode: () => 200,
      resStatus: () => 'OK', resTime: () => 1, reqGetAuth: () => ({ type: 'bearer', values: {} }),
      reqGetBodyMode: () => 'formdata',
    };
    const pm = runInNewContext(prelude + '\npm', { __kurloHost: host });
    const groups = {
      pm, 'pm.request': pm.request, 'pm.response': pm.response, 'pm.response.headers': pm.response.headers,
      'pm.request.body': pm.request.body, 'pm.request.body.formdata': pm.request.body.formdata,
      'pm.request.auth.parameters()': pm.request.auth.parameters(), assertion: Object.getPrototypeOf(pm.expect(1)),
      ...Object.fromEntries(['params', 'headers', 'pathVariables'].map(key => ['pm.request.' + key, pm.request[key]])),
      ...Object.fromEntries(['crypto', 'variables', 'globals', 'collectionVariables', 'environment', 'info', 'iterationData', 'execution', 'cookies'].map(key => ['pm.' + key, pm[key]])),
    };
    for (const [group, value] of Object.entries(groups)) {
      const keys = Object.getOwnPropertyNames(value).filter(key => key !== 'constructor');
      expect([...scriptMembers(group)!.keys()].sort(), group).toEqual(keys.sort());
    }
  });

  it('resolves nested members, calls, optional chains and hook-specific fields', () => {
    expect(labels('pm.|', false)).not.toContain('response');
    expect(labels('pm.response.|')).toContain('llm');
    expect(labels('pm.request.auth.parameters().|')).toContain('toJSON');
    expect(labels('pm.expect(\n  pm.response.json()\n).to.have.|')).toContain('jsonSchema');
    expect(labels('pm.request.body.formdata?.|')).toContain('upsert');
    expect(labels('pm.sendRequest(url).|', false)).toContain('body');
    expect(labels('console.log("pm.request.|")')).toEqual([]);
    expect(labels('// pm.|')).toEqual([]);
    expect(labels('other.pm.|')).toEqual([]);
    expect(labels('pm.request.body.json().|')).toEqual([]);
  });

  it('completes only relevant string arguments and replaces their contents safely', () => {
    expect(labels('pm.environment.set("x", "|")')).toEqual([]);
    expect(labels('pm.sendRequest("|")')).toEqual([]);
    expect(labels('pm.environment.get(\n"ba|se")')).toEqual(['baseUrl']);
    expect(labels('pm.variables.replaceIn("{{bas|}}")')).toEqual(['baseUrl']);
    expect(labels('pm.expect(pm.info.requestName).to.eql("Lo|")')).toEqual(["Login user's account"]);
    const s = "pm.info.requestName !== 'Lo|gin'";
    const result = complete(s)!;
    expect(s.slice(0, result.from) + result.options[0].apply + s.replace('|', '').slice(result.to)).toBe("pm.info.requestName !== 'Login user\\'s account'");
  });
});
