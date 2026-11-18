---
title: "Load test file"
---

Path: `workspaces/<workspace>/collections/<collection>/loadtests/<load test filesystemName>.yml`

A load test is a flow of requests from the same collection plus the load to put
on it and the criteria for passing. Each load test is one file; `order` keeps
the order of load tests within the collection.

```yaml
version: 1
order: 0
loadTest:
  id: lt-checkout
  name: Checkout flow
  settings:
    environment: staging
  thresholds:
    - metric: http_req_duration
      stat: p(95)
      op: <
      value: 300
    - metric: http_req_duration
      stat: p(99)
      op: <
      value: 400
      step: st-create
    - metric: http_req_failed
      stat: rate
      op: <
      value: 0.01
      abortOnFail: true
  data:
    path: data/users.csv
    mode: per-vu
  scenarios:
    - id: sc-main
      name: Checkout
      executor:
        type: ramping-vus
        stages:
          - durationMs: 120000
            target: 100
          - durationMs: 600000
            target: 100
          - durationMs: 60000
            target: 0
      steps:
        - id: st-login
          requestId: req-login
          once: true
          extract:
            - var: token
              from: json
              path: $.access_token
          checks:
            - type: status
              value: "200"
        - id: st-create
          requestId: req-create-order
          name: create_order
          thinkTimeMs: 500
          thinkJitterMs: 1000
          checks:
            - type: jsonExists
              path: $.id
```

| Field | Meaning |
|-------|---------|
| `scenarios` | The flow. Kurlo uses exactly one scenario. |
| `executor.type` | `constant-vus` (`vus`, `durationMs`), `ramping-vus` (`stages` of virtual users), `constant-arrival-rate` (`rate`, `durationMs`, `preAllocatedVUs`, `maxVUs`), `ramping-arrival-rate` (`stages` of iterations per time unit, `preAllocatedVUs`, `maxVUs`). `timeUnitMs` defaults to 1000. |
| `steps[].requestId` | An HTTP or GraphQL request in the same collection. The step sends it with the collection's defaults, auth and the selected environment. |
| `steps[].once` | Run the step once per virtual user, for example to log in. |
| `steps[].extract` | Save a value from the response as a variable for later steps: `from: json` with a `$.` path, `from: header` with the header name, or `from: regex` with a pattern that has one `( )` group. |
| `steps[].checks` | `status` (`value` is the expected code), `jsonExists` (`path`), `bodyContains` (`value`). A failed check does not stop the test. |
| `steps[].thinkTimeMs`, `thinkJitterMs` | Wait after the step, plus a random extra wait up to `thinkJitterMs`. |
| `thresholds` | `metric` is `http_req_duration` (stats `avg`, `min`, `med`, `max`, `p(90)`, `p(95)`, `p(99)`; `value` in milliseconds), `http_req_failed` or `checks` (stat `rate`; `value` from 0 to 1). `step` limits a threshold to one step by its id; `abortOnFail` stops the test when it fails. |
| `data` | A CSV or JSON file relative to the workspace folder. `mode` is `per-vu`, `per-iteration` or `random`. |
| `settings` | `environment` to run against, `insecure` to skip TLS certificate checks, `timeoutMs` per request. |

Durations are in milliseconds. A load test holds no secrets: values such as
passwords come from the environment when the test runs. Unlike other objects,
a load test keeps only the fields listed here; Kurlo drops unknown fields on
the next save. Load tests are optional, and a collection without a
`loadtests/` directory has none.
