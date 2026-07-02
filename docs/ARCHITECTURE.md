# Architecture Diagrams

Diagrams are [Mermaid](https://mermaid.js.org/) — they render natively on GitHub, GitLab,
and in VS Code with the "Markdown Preview Mermaid Support" extension.

## 1. Infrastructure / deployment diagram

Shows how the app is deployed (single container, no database) and how it reaches
multiple Kubernetes clusters purely through kubeconfig files — it never talks to a
cloud provider API directly.

```mermaid
flowchart LR
    subgraph Browser["Browser (operator)"]
        UI["static/index.html + app.js\n(dashboard UI)"]
    end

    subgraph Container["Docker container (Dockerfile)\nuvicorn app.main:app :8000"]
        API["FastAPI app\n(app/main.py)"]
        CM["ClusterManager\n(app/cluster_manager.py)"]
        COL["collectors.py\n(k8s objects -> UI dicts)"]
        CFG["config.py\nloads /config/config.yaml"]
        STATIC["StaticFiles mount\n/static"]
    end

    subgraph Volumes["Mounted volumes / secrets"]
        CFGFILE["config.yaml\n(CONFIG_PATH)"]
        KCFILES["kubeconfig file(s)\n~/.kube/*.yaml"]
    end

    UI -- "HTTP GET/POST /api/*" --> API
    UI -- "WebSocket /ws/.../exec" --> API
    API --> STATIC
    API --> CM
    API --> COL
    CM --> CFG
    CFG -. reads .-> CFGFILE
    CM -. reads .-> KCFILES
    COL -->|uses| CM

    subgraph K8sA["Cluster A (e.g. AWS EKS)"]
        APIA["kube-apiserver"]
        MSA["metrics-server (optional)"]
    end
    subgraph K8sB["Cluster B (e.g. DigitalOcean DOKS)"]
        APIB["kube-apiserver"]
        MSB["metrics-server (optional)"]
    end
    subgraph K8sN["Cluster N (GKE / AKS / on-prem ...)"]
        APIN["kube-apiserver"]
    end

    CM -- "kubernetes python client\n(exec plugin: aws eks get-token, etc.)" --> APIA
    CM -- "kubernetes python client\n(embedded/exec token)" --> APIB
    CM -- "kubernetes python client" --> APIN
    COL -.->|"metrics.k8s.io API"| MSA
    COL -.->|"metrics.k8s.io API"| MSB

    classDef ext fill:#eee,stroke:#999;
    class K8sA,K8sB,K8sN ext;
```

Key points reflected in the diagram:

- **Single stateless container** — no database; all state (`cluster_mgr`, per-cluster
  connection status) lives in process memory, rebuilt from `config.yaml` at startup
  (`app/main.py:36` lifespan hook).
- **Kubeconfig-only auth** — `ClusterManager` never talks to AWS/DO/GCP/Azure APIs
  itself; it hands each `ClusterConfig.kubeconfig_path`/`kubeconfig_context` to the
  `kubernetes` Python client, which drives whatever `exec:` plugin or embedded token
  the kubeconfig specifies.
- **Two live channels from the browser**: regular REST polling (`/api/clusters/...`)
  for dashboard data, and a WebSocket (`/ws/clusters/{name}/pods/{ns}/{pod}/exec`) that
  proxies an interactive shell into a pod via the Kubernetes exec subresource.

## 2. Class diagram

Core domain model: configuration → connection/auth state → collector functions that
turn live cluster objects into UI-ready dicts.

```mermaid
classDiagram
    class AppConfig {
        +int refresh_interval_seconds
        +Optional~str~ kubeconfig_path
        +list~ClusterConfig~ clusters
    }

    class ClusterConfig {
        +str name
        +Optional~str~ kubeconfig_path
        +Optional~str~ kubeconfig_context
        +Optional~str~ provider
        +Optional~str~ profile
        +Optional~str~ region
        +AuthConfig auth
    }

    class AuthConfig {
        +Literal type  "standard|interactive"
        +Optional~int~ ttl_seconds
        +int reauth_warn_seconds
        +Optional~str~ login_command
        +Optional~str~ login_hint
    }

    class ClusterManager {
        +AppConfig app_cfg
        +dict~str, ClusterClient~ clients
        +get(name) ClusterClient
        +all() list~ClusterClient~
    }

    class ClusterClient {
        +ClusterConfig cfg
        +Optional~str~ default_kubeconfig_path
        +ApiClient api_client
        +str status  "connected|expired|error|unknown"
        +Optional~float~ last_auth_time
        +Optional~str~ last_error
        +connect() void
        +check_health() bool
        +note_request_error(e) void
        +seconds_until_expiry() Optional~int~
        +is_expiring_soon() bool
        +is_expired() bool
        +core_v1() CoreV1Api
        +apps_v1() AppsV1Api
        +custom() CustomObjectsApi
    }

    class collectors {
        <<module>>
        +get_pods(cc, ns) list
        +get_nodes(cc) list
        +get_workloads(cc, ns) list
        +get_events(cc, ns, warnings_only) list
        +get_node_metrics(cc) list
        +get_pod_metrics(cc, ns) list
        +get_namespaces(cc) list
        +get_pvcs_with_pods(cc, ns) list
        +get_services(cc, ns) list
        +get_jobs(cc, ns) list
        +get_cronjobs(cc, ns) list
        +describe_pod(cc, ns, name) dict
        +describe_node(cc, name) dict
        +describe_workload(cc, ns, kind, name) dict
        +get_pod_logs(cc, ns, name, ...) str
        +get_overview(cc) dict
    }

    class FastAPIApp {
        <<app/main.py>>
        +cluster_mgr ClusterManager
        +lifespan()
        +REST routes /api/clusters/...
        +WS route /ws/clusters/.../exec
    }

    AppConfig "1" *-- "many" ClusterConfig
    ClusterConfig "1" *-- "1" AuthConfig
    ClusterManager "1" o-- "1" AppConfig
    ClusterManager "1" *-- "many" ClusterClient
    ClusterClient "1" o-- "1" ClusterConfig
    FastAPIApp "1" --> "1" ClusterManager : holds singleton
    FastAPIApp --> collectors : calls
    collectors --> ClusterClient : reads core_v1/apps_v1/custom
```

## 3. Cluster connection state diagram

Every `ClusterClient` tracks its own connection/auth lifecycle independently, so one
expired cluster doesn't affect others. This mirrors the `status` field driven by
`connect()`, `check_health()`, and `note_request_error()` in `app/cluster_manager.py`.

```mermaid
stateDiagram-v2
    [*] --> unknown: ClusterClient created

    unknown --> connected: connect() succeeds\n(VersionApi probe OK)
    unknown --> error: connect() fails\n(non-auth error)
    unknown --> expired: connect() fails\n(auth-looking error)

    connected --> connected: check_health() OK\n(periodic probe)
    connected --> expired: check_health() fails with\nauth-looking error, OR\nnote_request_error() during\na collector call detects\nExpiredToken/401/Unauthorized
    connected --> error: check_health() fails with\nnon-auth error

    connected --> connected: TTL still valid\n(interactive auth, seconds_until_expiry > warn window)
    connected --> expiring_soon: interactive auth AND\n0 < seconds_until_expiry <= reauth_warn_seconds
    expiring_soon --> connected: reconnect() before TTL hits 0\n(fresh connect() succeeds)
    expiring_soon --> expired: TTL reaches 0\n(seconds_until_expiry <= 0)

    error --> connected: POST /reconnect or /check\nsucceeds
    error --> error: POST /check still fails

    expired --> connected: user re-authenticates\n(login_command) then\nPOST /reconnect succeeds
    expired --> expired: POST /reconnect still fails\n(still bad credentials)

    note right of expiring_soon
        UI-only derived state:
        is_expiring_soon() == true
        while status stays "connected".
        Not a literal field value.
    end note
```

## 4. Pod exec WebSocket sequence

Bonus — the one genuinely stateful, bidirectional flow in the app (`app/main.py:230`),
worth capturing since it's easy to misread from the code alone.

```mermaid
sequenceDiagram
    participant B as Browser (xterm.js)
    participant WS as FastAPI WebSocket handler
    participant T as Poll thread
    participant K as kube-apiserver (exec subresource)

    B->>WS: WS connect /ws/clusters/{name}/pods/{ns}/{pod}/exec
    WS->>WS: accept() and look up ClusterClient
    alt cluster not connected
        WS-->>B: close(1008)
    else connected
        WS->>K: k8s_stream(connect_get_namespaced_pod_exec, tty=True)
        WS->>T: start daemon thread (_poll)
        loop while resp.is_open()
            T->>K: resp.update(timeout=5ms)
            K-->>T: stdout/stderr frames
            T->>WS: queue.put_nowait(chunk) via call_soon_threadsafe
        end
        par forward output
            WS->>B: send_text(chunk) for each queued frame
        and forward input
            B->>WS: receive_text() (keystrokes or resize JSON)
            alt resize message
                WS->>K: write_channel(4, {Width, Height})
            else regular input
                WS->>K: resp.write_stdin(msg)
            end
        end
        B--)WS: disconnect (or shell exits)
        WS->>K: resp.close()
        WS-->>B: close()
    end
```
