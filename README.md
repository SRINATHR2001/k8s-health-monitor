# K8s Health Monitor

A lightweight, multi-cluster Kubernetes health dashboard. Monitors pod status & restarts,
node health & capacity, deployment/statefulset rollouts, CPU/memory usage (via metrics-server),
and recent K8s events — across many clusters from a single browser window.

**Provider-agnostic.** Works with AWS EKS, DigitalOcean DOKS, GCP GKE, Azure AKS, or
any other Kubernetes cluster — as long as you have a working kubeconfig file. The
dashboard never speaks to a cloud provider directly; it loads each kubeconfig and lets
that file's auth mechanism (embedded token, `exec` plugin, etc.) handle credentials.

Special handling for clusters where the underlying session has a finite TTL — e.g. AWS
SSO with TOTP that expires after 1 hour — including a live countdown, an automatic
re-auth banner, and explicit "I've re-authenticated" reconnection.

## Why this is shaped the way it is

- **Connection:** every cluster is just a kubeconfig file. The `kubernetes` Python
  client reads the kubeconfig, including any embedded token or `exec:` block, and
  refreshes credentials per request as needed. We don't manage cloud credentials
  ourselves — the kubeconfig already knows how.
- **Long-lived auth** (your standard AWS profiles, DO API tokens, GCP service accounts)
  just work as long as the underlying credentials are valid.
- **Session-with-finite-TTL clusters** (AWS SSO + TOTP, SAML, Okta, etc.) are marked
  `auth.type: interactive` with a known `ttl_seconds`. A live countdown shows in the
  sidebar; an amber banner appears in the warning window; a red one when expired. The
  banner shows the exact `login_command` — you paste it into your terminal, complete
  the MFA prompt, then click **"I've re-authenticated"** to reconnect.
- **Mid-request expiry detection:** if any API call returns `ExpiredToken` /
  `Unauthorized` / 401, the cluster auto-flips to `expired` and the banner appears
  without waiting for the TTL countdown.

We deliberately do **not** try to automate MFA — that would defeat its purpose. The
"show the command, you run it, click confirm" pattern is intentional.

## Provider-specific notes

### AWS EKS
Generate per-cluster kubeconfig:
```bash
aws eks update-kubeconfig \
  --name <cluster> --region <region> --profile <profile> \
  --kubeconfig ~/.kube/<cluster>.yaml
```
The resulting file has an `exec` block calling `aws eks get-token`. Set
`provider: aws` and `profile: <aws-profile>` for display.

### DigitalOcean DOKS
Generate per-cluster kubeconfig:
```bash
doctl kubernetes cluster kubeconfig save <cluster> \
  --save-config-path ~/.kube/do-<cluster>.yaml
```
Depending on the doctl version, this produces either an embedded long-lived bearer
token or an `exec` block calling `doctl kubernetes cluster kubeconfig exec-credential`.
Both work without special handling. Set `provider: digitalocean`.

DO tokens themselves don't expire on a fixed schedule unless you set `--expiry-seconds`
on save, so most DOKS clusters use the default `auth.type: standard`.

### Other (GKE, AKS, on-prem)
Anything that produces a valid kubeconfig — `gcloud container clusters get-credentials`,
`az aks get-credentials`, a hand-written one — works the same way. Just point
`kubeconfig_path` at it.

## Setup

### 1. Have one kubeconfig per cluster

This app supports either pattern:

- **One kubeconfig file per cluster** (common when each cluster's kubeconfig
  came from a different team / IaC pipeline). Set `kubeconfig_path` per cluster.
- **Single merged kubeconfig with many contexts** (e.g. you ran `aws eks
  update-kubeconfig` four times against the same `~/.kube/config`). Set the
  app-level `kubeconfig_path` once (or omit it to use the default) and name
  the `kubeconfig_context` for each cluster.

Sanity-check each kubeconfig works standalone:

```bash
KUBECONFIG=~/.kube/prod.yaml kubectl get nodes
```

If that works, the dashboard will work — it uses the exact same machinery
(including the embedded `exec: aws eks get-token …` block).

### 2. Configure clusters

```bash
cp config.example.yaml config.yaml
$EDITOR config.yaml
```

For each cluster, set `kubeconfig_path` to the file. If a file has only one
context, you can omit `kubeconfig_context` — the file's current-context is
used. For the TOTP cluster, also fill in the `auth:` block with
`type: interactive`, `ttl_seconds: 3600`, and the exact `login_command` you
run today.

`~` and `$VAR` in `kubeconfig_path` are expanded.

### 3. Install & run

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8080
```

Open <http://localhost:8080>.

## Tabs

- **Overview** — top-line counts (pods healthy / nodes ready / workloads healthy) plus
  problematic-pod, degraded-workload, not-ready-node, and recent-warning lists.
- **Pods** — all pods with phase, ready, restart count, reason (e.g. `CrashLoopBackOff`,
  `ImagePullBackOff`), node, age. Unhealthy rows are highlighted.
- **Nodes** — readiness, pressure conditions, CPU/memory used vs allocatable (needs
  metrics-server), instance type, zone, kubelet version.
- **Workloads** — Deployments + StatefulSets with replica counts and rollout state.
- **Events** — last ~200 events, newest first, warnings highlighted.

## Project layout

```
k8s-health-monitor/
├── app/
│   ├── config.py            # YAML config models
│   ├── cluster_manager.py   # Per-cluster client + auth state tracking
│   ├── collectors.py        # Turn k8s API objects into UI dicts
│   └── main.py              # FastAPI app + routes
├── static/
│   ├── index.html
│   └── app.js
├── config.example.yaml
├── requirements.txt
└── README.md
```

## API

| Method | Path | Notes |
|---|---|---|
| GET  | `/api/config` | Frontend bootstrap |
| GET  | `/api/clusters` | All clusters + status, expiry countdown, errors |
| POST | `/api/clusters/{name}/check` | Re-test connection (light probe) |
| POST | `/api/clusters/{name}/reconnect` | Build a fresh client — call after re-auth |
| GET  | `/api/clusters/{name}/overview` | Health rollup |
| GET  | `/api/clusters/{name}/pods?namespace=` | |
| GET  | `/api/clusters/{name}/nodes` | |
| GET  | `/api/clusters/{name}/workloads?namespace=` | Deployments + StatefulSets |
| GET  | `/api/clusters/{name}/events?namespace=&warnings_only=` | |
| GET  | `/api/clusters/{name}/metrics/nodes` | Needs metrics-server |
| GET  | `/api/clusters/{name}/metrics/pods?namespace=` | Needs metrics-server |

## Extending

- **Alerts** — wrap `collectors.get_overview` in a background task and POST to Slack
  when problem counts cross a threshold.
- **Caching** — wrap collectors in a TTL cache (`cachetools.TTLCache`, 15–30s) if you
  hit API server rate limits with many users.
- **More resources** — Jobs, CronJobs, Ingresses, PVCs follow the same `_safe(cc, ...)`
  pattern in `collectors.py`. Add a route in `main.py` and a tab in `static/app.js`.
- **Auth providers** — the `auth: interactive` pattern is provider-agnostic. Whatever
  command produces a fresh kubeconfig-usable session (saml2aws, aws-vault, okta-aws-cli,
  custom OIDC) just goes in `login_command`.

## Troubleshooting

- **All requests 503 with "unable to load exec plugin"** — the kubeconfig context's
  `exec` block expects `aws` on PATH. Activate the right venv / shell.
- **Metrics tab empty** — `kubectl top nodes` likely fails too. Install metrics-server:
  `kubectl apply -f https://github.com/kubernetes-sigs/metrics-server/releases/latest/download/components.yaml`.
- **TOTP cluster's countdown is wrong** — TTL is whatever you set in `ttl_seconds`. If
  your session actually lives longer (or shorter), adjust it.
- **Cluster status "error" but `kubectl` works** — check the error text in the banner.
  Common: VPN not connected, wrong AWS_PROFILE in your shell, kubeconfig context typo.
