import http from 'k6/http';
import { check, group, sleep } from 'k6';
import encoding from 'k6/encoding';

export const options = {
  scenarios: {
    main: {
      executor: "constant-arrival-rate",
      rate: 20,
      timeUnit: "1s",
      duration: "1m30s",
      preAllocatedVUs: 10,
      maxVUs: 50,
    },
  },
  thresholds: {
    "checks{step:bucket}": [],
    "checks{step:legacy}": [],
    "checks{step:report}": [],
    "checks{step:status}": [],
    "checks{step:sync_2}": [],
    "checks{step:sync}": [],
    "checks{step:upload}": [],
    "http_req_duration{step:bucket}": [],
    "http_req_duration{step:legacy}": [],
    "http_req_duration{step:report}": [],
    "http_req_duration{step:status}": [],
    "http_req_duration{step:sync_2}": [],
    "http_req_duration{step:sync}": [],
    "http_req_duration{step:upload}": [],
    "http_req_failed{step:bucket}": [],
    "http_req_failed{step:legacy}": [],
    "http_req_failed{step:report}": [],
    "http_req_failed{step:status}": [],
    "http_req_failed{step:sync_2}": [],
    "http_req_failed{step:sync}": [],
    "http_req_failed{step:upload}": [],
  },
  summaryTrendStats: ["avg","min","med","max","p(90)","p(95)","p(99)"],
  insecureSkipTLSVerify: true,
};

const DEFAULTS = {
};
const DYNAMIC = {
  "$timestamp": () => String(Math.floor(Date.now() / 1000)),
};

const vu = {};
const done = {};
let row = {};

function env(name, depth) {
  const raw = __ENV[name] !== undefined ? __ENV[name] : DEFAULTS[name];
  return raw === undefined ? undefined : t(String(raw), depth + 1);
}

function lookup(name, depth) {
  if (name in vu) return vu[name] === undefined ? undefined : String(vu[name]);
  if (name in row) return String(row[name]);
  if (name in DYNAMIC) return DYNAMIC[name]();
  return env(name, depth);
}

function t(text, depth = 0) {
  if (depth > 10) return text;
  return text.replace(/\{\{([^{}]*)\}\}/g, (match, key) => {
    const value = lookup(key.trim(), depth);
    return value === undefined ? match : value;
  });
}

function q(url, pairs) {
  const query = pairs.map(([key, value]) => encodeURIComponent(key) + '=' + encodeURIComponent(value)).join('&');
  if (!query) return url;
  return url + (url.includes('?') ? '&' : '?') + query;
}

function withUser(url, user, password) {
  return url.replace('://', '://' + encodeURIComponent(user) + ':' + encodeURIComponent(password) + '@');
}

function header(res, name) {
  const key = Object.keys(res.headers).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key === undefined ? undefined : res.headers[key];
}

export function setup() {
  const tokens = [];
  const token0 = http.post("https://id.partner.test/token", { grant_type: "client_credentials", scope: "sync" }, { headers: { Authorization: 'Basic ' + encoding.b64encode(t("kurlo:{{clientSecret}}")) } });
  check(token0, { 'token received': (r) => r.status === 200 });
  tokens.push(token0.json('access_token'));
  return { tokens };
}

export default function (data) {
  group("sync", () => {
    const res = http.request("POST", "https://partner.test/sync", { "since": t("{{$timestamp}}") }, { headers: { "Authorization": 'Bearer ' + data.tokens[0] }, tags: { step: "sync" } });
    vu["trace"] = header(res, "X-Trace-Id");
    vu["cursor"] = ((typeof res.body === 'string' ? res.body : '').match(new RegExp("next=(\\w+)")) || [])[1];
  });
  group("sync_2", () => {
    const res = http.request("POST", "https://partner.test/sync", { "since": t("{{$timestamp}}") }, { headers: { "Authorization": 'Bearer ' + data.tokens[0] }, tags: { step: "sync_2" } });
  });
  group("report", () => {
    const res = http.request("GET", "https://partner.test/report", null, { headers: { "Authorization": 'Basic ' + encoding.b64encode(t("ops:{{opsPassword}}")) }, tags: { step: "report" } });
  });
  group("status", () => {
    const res = http.request("GET", q("https://partner.test/status?v=2", [["api_key", t("{{apiKey}}")]]), null, { tags: { step: "status" } });
  });
  group("legacy", () => {
    const res = http.request("GET", withUser("https://partner.test/legacy", "legacy", t("{{legacyPassword}}")), null, { tags: { step: "legacy" }, auth: 'digest' });
  });
  group("bucket", () => {
    const res = http.request("GET", "https://s3.test/bucket", null, { tags: { step: "bucket" } });
  });
  group("upload", () => {
    const res = http.request("POST", "https://partner.test/upload", { "title": "report" }, { tags: { step: "upload" } });
  });
}
