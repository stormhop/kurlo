import http from 'k6/http';
import { check, group, sleep } from 'k6';
import { SharedArray } from 'k6/data';

export const options = {
  scenarios: {
    main: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: [{ duration: "2m", target: 100 }, { duration: "10m", target: 100 }, { duration: "1m", target: 0 }],
    },
  },
  thresholds: {
    "checks{step:create_order}": [],
    "checks{step:list_orders}": [],
    "checks{step:login}": [],
    "checks{step:order_details}": [],
    "http_req_duration": ["p(95)<300"],
    "http_req_duration{step:create_order}": ["p(99)<400"],
    "http_req_duration{step:list_orders}": [],
    "http_req_duration{step:login}": [],
    "http_req_duration{step:order_details}": [],
    "http_req_failed": [{ threshold: "rate<0.01", abortOnFail: true }],
    "http_req_failed{step:create_order}": [],
    "http_req_failed{step:list_orders}": [],
    "http_req_failed{step:login}": [],
    "http_req_failed{step:order_details}": [],
    "http_reqs{step:create_order}": [],
    "http_reqs{step:list_orders}": [],
    "http_reqs{step:login}": [],
    "http_reqs{step:order_details}": [],
  },
  summaryTrendStats: ["avg","min","med","max","p(90)","p(95)","p(99)"],
};

const DEFAULTS = {
  "baseUrl": "{{host}}/api",
  "host": "https://staging.shop.test",
};
const DATA = new SharedArray('data', () => [{"email":"ada@shop.test"},{"email":"grace@shop.test"}]);
const DYNAMIC = {
  "$guid": uuid,
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

function uuid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = Math.floor(Math.random() * 16);
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

function q(url, pairs) {
  const query = pairs.map(([key, value]) => encodeURIComponent(key) + '=' + encodeURIComponent(value)).join('&');
  if (!query) return url;
  return url + (url.includes('?') ? '&' : '?') + query;
}

function jsonAt(res, path) {
  try {
    return path ? res.json(path) : res.json();
  } catch (error) {
    return undefined;
  }
}

export default function () {
  row = DATA[(__VU - 1) % DATA.length];
  if (!done["st-login"]) {
    group("login", () => {
      const res = http.request("POST", t("{{baseUrl}}/auth/login"), t("{\"email\":\"{{email}}\",\"password\":\"{{password}}\"}"), { headers: { "Content-Type": "application/json" }, tags: { step: "login" }, timeout: "10s" });
      check(res, {
        "status is 200": (r) => r.status === 200,
      }, { step: "login" });
      vu["token"] = jsonAt(res, "access_token");
    });
    done["st-login"] = true;
  }
  group("list_orders", () => {
    const res = http.request("GET", q(t("{{baseUrl}}/orders"), [["limit", "20"], ["trace", t("{{$guid}}")]]), null, { headers: { "X-Team": "checkout", "Authorization": t("Bearer {{token}}") }, tags: { step: "list_orders" }, timeout: "10s" });
    check(res, {
      "$.items exists": (r) => jsonAt(r, "items") !== undefined,
    }, { step: "list_orders" });
    vu["orderId"] = jsonAt(res, "items.0.id");
  });
  sleep(0.5 + Math.random() * 1);
  group("order_details", () => {
    const res = http.request("GET", t("{{baseUrl}}/orders/{{orderId}}"), null, { headers: { "Authorization": t("Bearer {{token}}") }, tags: { step: "order_details" }, timeout: "10s" });
  });
  group("create_order", () => {
    const res = http.request("POST", t("{{baseUrl}}/graphql"), "{\"query\":\"mutation { createOrder { id } }\"}", { headers: { "Content-Type": "application/json", "Authorization": t("Bearer {{token}}") }, tags: { step: "create_order" }, timeout: "10s" });
    check(res, {
      "status is 201": (r) => r.status === 201,
      "body contains \"{{orderId}}\"": (r) => typeof r.body === 'string' && r.body.includes(t("{{orderId}}")),
    }, { step: "create_order" });
  });
  sleep(2);
}
