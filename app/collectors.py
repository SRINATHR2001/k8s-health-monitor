"""Resource collectors — turn k8s API objects into UI-friendly dicts.

Each function takes a ClusterClient and (optionally) a namespace, swallows
ApiException (returning [] + flipping cluster status on auth errors), and
returns plain dicts.
"""
from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import Any, Optional

from kubernetes.client.exceptions import ApiException

from app.cluster_manager import ClusterClient

log = logging.getLogger(__name__)


def _age_seconds(ts) -> Optional[int]:
    if not ts:
        return None
    # k8s timestamps are tz-aware UTC
    return int((datetime.now(timezone.utc) - ts).total_seconds())


def _safe(cc: ClusterClient, fn, default):
    try:
        return fn()
    except ApiException as e:
        log.warning("[%s] API error: %s", cc.cfg.name, e.reason)
        cc.note_request_error(e)
        return default
    except Exception as e:  # noqa: BLE001 — includes exec plugin / kubeconfig errors
        log.warning("[%s] error: %s", cc.cfg.name, e)
        cc.note_request_error(e)
        return default


# ---------- pods ----------

def _container_state(cs) -> dict[str, Any]:
    if cs.state.waiting:
        return {"state": "waiting", "reason": cs.state.waiting.reason, "message": cs.state.waiting.message}
    if cs.state.terminated:
        return {"state": "terminated", "reason": cs.state.terminated.reason, "exit_code": cs.state.terminated.exit_code}
    if cs.state.running:
        return {"state": "running", "started_at": cs.state.running.started_at.isoformat() if cs.state.running.started_at else None}
    return {"state": "unknown"}


def _pod_summary(p) -> dict[str, Any]:
    statuses = p.status.container_statuses or []
    restarts = sum(cs.restart_count for cs in statuses)
    ready = sum(1 for cs in statuses if cs.ready)
    total = len(p.spec.containers)
    waiting_reasons = [cs.state.waiting.reason for cs in statuses if cs.state.waiting and cs.state.waiting.reason]
    return {
        "namespace": p.metadata.namespace,
        "name": p.metadata.name,
        "phase": p.status.phase,
        "ready": f"{ready}/{total}",
        "ready_count": ready,
        "total_count": total,
        "restarts": restarts,
        "node": p.spec.node_name,
        "age_seconds": _age_seconds(p.metadata.creation_timestamp),
        "reason": waiting_reasons[0] if waiting_reasons else None,
        "container_names": [c.name for c in p.spec.containers],
        "containers": [{"name": cs.name, **_container_state(cs)} for cs in statuses],
        "healthy": p.status.phase in ("Running", "Succeeded") and ready == total and not waiting_reasons,
    }


def get_pods(cc: ClusterClient, namespace: Optional[str] = None) -> list[dict]:
    def fetch():
        if namespace:
            return cc.core_v1.list_namespaced_pod(namespace).items
        return cc.core_v1.list_pod_for_all_namespaces().items
    pods = _safe(cc, fetch, [])
    return [_pod_summary(p) for p in pods]


# ---------- nodes ----------

def _parse_cpu(v: Optional[str]) -> Optional[float]:
    """Parse a cpu quantity (e.g. '2', '500m', '1500m') to cores."""
    if v is None:
        return None
    if v.endswith("n"):  # nanocores
        return int(v[:-1]) / 1_000_000_000
    if v.endswith("u"):  # microcores
        return int(v[:-1]) / 1_000_000
    if v.endswith("m"):  # millicores
        return int(v[:-1]) / 1000
    return float(v)


def _parse_memory(v: Optional[str]) -> Optional[int]:
    """Parse a memory quantity to bytes."""
    if v is None:
        return None
    units = {
        "Ki": 1024, "Mi": 1024**2, "Gi": 1024**3, "Ti": 1024**4,
        "K": 1000,  "M": 1000**2,  "G": 1000**3,  "T": 1000**4,
    }
    for suffix, mult in units.items():
        if v.endswith(suffix):
            return int(v[:-len(suffix)]) * mult
    return int(v)


def _node_summary(n) -> dict[str, Any]:
    conditions = {c.type: c.status for c in (n.status.conditions or [])}
    ready = conditions.get("Ready") == "True"
    pressure_conditions = [k for k in ("MemoryPressure", "DiskPressure", "PIDPressure") if conditions.get(k) == "True"]
    cap = n.status.capacity or {}
    alloc = n.status.allocatable or {}
    labels = n.metadata.labels or {}
    return {
        "name": n.metadata.name,
        "ready": ready,
        "schedulable": not (n.spec.unschedulable or False),
        "conditions": conditions,
        "pressure": pressure_conditions,
        "capacity": {
            "cpu_cores": _parse_cpu(cap.get("cpu")),
            "memory_bytes": _parse_memory(cap.get("memory")),
            "pods": int(cap.get("pods", 0)),
        },
        "allocatable": {
            "cpu_cores": _parse_cpu(alloc.get("cpu")),
            "memory_bytes": _parse_memory(alloc.get("memory")),
            "pods": int(alloc.get("pods", 0)),
        },
        "kubelet_version": n.status.node_info.kubelet_version if n.status.node_info else None,
        "instance_type": labels.get("node.kubernetes.io/instance-type") or labels.get("beta.kubernetes.io/instance-type"),
        "zone": labels.get("topology.kubernetes.io/zone") or labels.get("failure-domain.beta.kubernetes.io/zone"),
        "age_seconds": _age_seconds(n.metadata.creation_timestamp),
    }


def get_nodes(cc: ClusterClient) -> list[dict]:
    nodes = _safe(cc, lambda: cc.core_v1.list_node().items, [])
    return [_node_summary(n) for n in nodes]


# ---------- deployments + statefulsets ----------

def _dep_summary(d) -> dict[str, Any]:
    s = d.status
    spec_replicas = d.spec.replicas or 0
    ready = s.ready_replicas or 0
    updated = s.updated_replicas or 0
    available = s.available_replicas or 0
    conditions = {c.type: c.status for c in (s.conditions or [])}
    return {
        "namespace": d.metadata.namespace,
        "name": d.metadata.name,
        "kind": "Deployment",
        "replicas": spec_replicas,
        "ready": ready,
        "updated": updated,
        "available": available,
        "unavailable": s.unavailable_replicas or 0,
        "conditions": conditions,
        "rollout_complete": ready == spec_replicas and updated == spec_replicas,
        "healthy": ready == spec_replicas and conditions.get("Available") == "True",
        "age_seconds": _age_seconds(d.metadata.creation_timestamp),
    }


def _sts_summary(s) -> dict[str, Any]:
    st = s.status
    spec_replicas = s.spec.replicas or 0
    ready = st.ready_replicas or 0
    return {
        "namespace": s.metadata.namespace,
        "name": s.metadata.name,
        "kind": "StatefulSet",
        "replicas": spec_replicas,
        "ready": ready,
        "updated": st.updated_replicas or 0,
        "current": st.current_replicas or 0,
        "rollout_complete": ready == spec_replicas and (st.updated_replicas or 0) == spec_replicas,
        "healthy": ready == spec_replicas,
        "age_seconds": _age_seconds(s.metadata.creation_timestamp),
    }


def _ds_summary(d) -> dict[str, Any]:
    s = d.status
    desired = s.desired_number_scheduled or 0
    ready = s.number_ready or 0
    return {
        "namespace": d.metadata.namespace,
        "name": d.metadata.name,
        "kind": "DaemonSet",
        "replicas": desired,
        "ready": ready,
        "updated": s.updated_number_scheduled or 0,
        "available": s.number_available or 0,
        "unavailable": s.number_unavailable or 0,
        "rollout_complete": ready == desired and (s.updated_number_scheduled or 0) == desired,
        "healthy": ready == desired,
        "age_seconds": _age_seconds(d.metadata.creation_timestamp),
    }


def get_workloads(cc: ClusterClient, namespace: Optional[str] = None) -> list[dict]:
    def fetch_deps():
        if namespace:
            return cc.apps_v1.list_namespaced_deployment(namespace).items
        return cc.apps_v1.list_deployment_for_all_namespaces().items

    def fetch_sts():
        if namespace:
            return cc.apps_v1.list_namespaced_stateful_set(namespace).items
        return cc.apps_v1.list_stateful_set_for_all_namespaces().items

    def fetch_ds():
        if namespace:
            return cc.apps_v1.list_namespaced_daemon_set(namespace).items
        return cc.apps_v1.list_daemon_set_for_all_namespaces().items

    deps = _safe(cc, fetch_deps, [])
    sts = _safe(cc, fetch_sts, [])
    ds = _safe(cc, fetch_ds, [])
    return [_dep_summary(d) for d in deps] + [_sts_summary(s) for s in sts] + [_ds_summary(d) for d in ds]


# ---------- events ----------

def _event_ts(e):
    return e.last_timestamp or e.event_time or e.metadata.creation_timestamp


def _event_summary(e) -> dict[str, Any]:
    ts = _event_ts(e)
    return {
        "type": e.type,
        "reason": e.reason,
        "message": e.message,
        "namespace": e.metadata.namespace,
        "object": f"{e.involved_object.kind}/{e.involved_object.name}" if e.involved_object else None,
        "count": e.count or 1,
        "last_timestamp": ts.isoformat() if ts else None,
        "age_seconds": _age_seconds(ts),
    }


def get_events(cc: ClusterClient, namespace: Optional[str] = None, warnings_only: bool = False) -> list[dict]:
    def fetch():
        if namespace:
            return cc.core_v1.list_namespaced_event(namespace).items
        return cc.core_v1.list_event_for_all_namespaces().items

    evs = _safe(cc, fetch, [])
    if warnings_only:
        evs = [e for e in evs if e.type == "Warning"]
    evs.sort(key=lambda e: _event_ts(e) or datetime.min.replace(tzinfo=timezone.utc), reverse=True)
    return [_event_summary(e) for e in evs[:200]]


# ---------- metrics (requires metrics-server installed in-cluster) ----------

def get_node_metrics(cc: ClusterClient) -> list[dict]:
    def fetch():
        return cc.custom.list_cluster_custom_object(
            group="metrics.k8s.io", version="v1beta1", plural="nodes"
        )
    result = _safe(cc, fetch, {"items": []})
    out = []
    for it in result.get("items", []):
        usage = it.get("usage", {})
        out.append({
            "name": it["metadata"]["name"],
            "cpu_cores": _parse_cpu(usage.get("cpu")),
            "memory_bytes": _parse_memory(usage.get("memory")),
        })
    return out


def get_pod_metrics(cc: ClusterClient, namespace: Optional[str] = None) -> list[dict]:
    def fetch():
        if namespace:
            return cc.custom.list_namespaced_custom_object(
                group="metrics.k8s.io", version="v1beta1",
                namespace=namespace, plural="pods"
            )
        return cc.custom.list_cluster_custom_object(
            group="metrics.k8s.io", version="v1beta1", plural="pods"
        )
    result = _safe(cc, fetch, {"items": []})
    out = []
    for it in result.get("items", []):
        total_cpu = 0.0
        total_mem = 0
        for c in it.get("containers", []):
            total_cpu += _parse_cpu(c.get("usage", {}).get("cpu")) or 0
            total_mem += _parse_memory(c.get("usage", {}).get("memory")) or 0
        out.append({
            "namespace": it["metadata"]["namespace"],
            "name": it["metadata"]["name"],
            "cpu_cores": total_cpu,
            "memory_bytes": total_mem,
        })
    return out


# ---------- persistent volume claims ----------

def _pvc_summary(p) -> dict[str, Any]:
    cap = p.status.capacity or {}
    return {
        "namespace": p.metadata.namespace,
        "name": p.metadata.name,
        "status": p.status.phase,
        "storage_class": p.spec.storage_class_name,
        "capacity_bytes": _parse_memory(cap.get("storage")),
        "access_modes": p.spec.access_modes or [],
        "volume_name": p.spec.volume_name,
        "age_seconds": _age_seconds(p.metadata.creation_timestamp),
        "healthy": p.status.phase == "Bound",
    }


def get_pvcs(cc: ClusterClient, namespace: Optional[str] = None) -> list[dict]:
    def fetch():
        if namespace:
            return cc.core_v1.list_namespaced_persistent_volume_claim(namespace).items
        return cc.core_v1.list_persistent_volume_claim_for_all_namespaces().items
    pvcs = _safe(cc, fetch, [])
    return [_pvc_summary(p) for p in pvcs]


# ---------- namespaces ----------

def get_namespaces(cc: ClusterClient) -> list[str]:
    def fetch():
        return cc.core_v1.list_namespace().items
    items = _safe(cc, fetch, [])
    return sorted(n.metadata.name for n in items)


# ---------- services ----------

def _svc_summary(s) -> dict[str, Any]:
    spec = s.spec
    lb_ip = None
    if s.status and s.status.load_balancer and s.status.load_balancer.ingress:
        first = s.status.load_balancer.ingress[0]
        lb_ip = first.ip or first.hostname
    ports = [
        {
            "name": p.name,
            "port": p.port,
            "target_port": str(p.target_port),
            "protocol": p.protocol,
            "node_port": p.node_port,
        }
        for p in (spec.ports or [])
    ]
    return {
        "namespace": s.metadata.namespace,
        "name": s.metadata.name,
        "type": spec.type,
        "cluster_ip": spec.cluster_ip,
        "external_ips": spec.external_i_ps or [],
        "load_balancer_ip": lb_ip,
        "ports": ports,
        "selector": spec.selector or {},
        "age_seconds": _age_seconds(s.metadata.creation_timestamp),
    }


def get_services(cc: ClusterClient, namespace: Optional[str] = None) -> list[dict]:
    def fetch():
        if namespace:
            return cc.core_v1.list_namespaced_service(namespace).items
        return cc.core_v1.list_service_for_all_namespaces().items
    return [_svc_summary(s) for s in _safe(cc, fetch, [])]


# ---------- batch: jobs + cronjobs ----------

def _job_summary(j) -> dict[str, Any]:
    s = j.status
    spec = j.spec
    conditions = {c.type: c.status for c in (s.conditions or [])}
    complete = conditions.get("Complete") == "True"
    job_failed = conditions.get("Failed") == "True"
    duration = None
    if s.start_time and s.completion_time:
        duration = int((s.completion_time - s.start_time).total_seconds())
    return {
        "namespace": j.metadata.namespace,
        "name": j.metadata.name,
        "completions": spec.completions or 1,
        "parallelism": spec.parallelism or 1,
        "succeeded": s.succeeded or 0,
        "failed_pods": s.failed or 0,
        "active": s.active or 0,
        "start_time": s.start_time.isoformat() if s.start_time else None,
        "completion_time": s.completion_time.isoformat() if s.completion_time else None,
        "duration_seconds": duration,
        "age_seconds": _age_seconds(j.metadata.creation_timestamp),
        "complete": complete,
        "failed_status": job_failed,
        "healthy": complete and not job_failed,
        "owner": next(
            (r.name for r in (j.metadata.owner_references or []) if r.kind == "CronJob"),
            None,
        ),
    }


def get_jobs(cc: ClusterClient, namespace: Optional[str] = None) -> list[dict]:
    from kubernetes import client as k8s_client
    batch = k8s_client.BatchV1Api(cc.api_client)

    def fetch():
        if namespace:
            return batch.list_namespaced_job(namespace).items
        return batch.list_job_for_all_namespaces().items

    return [_job_summary(j) for j in _safe(cc, fetch, [])]


def _cronjob_summary(cj) -> dict[str, Any]:
    s = cj.status
    spec = cj.spec
    active = s.active or []
    last_sched = s.last_schedule_time
    last_success = getattr(s, "last_successful_time", None)
    return {
        "namespace": cj.metadata.namespace,
        "name": cj.metadata.name,
        "schedule": spec.schedule,
        "suspend": spec.suspend or False,
        "active": len(active),
        "last_schedule": last_sched.isoformat() if last_sched else None,
        "last_schedule_age_seconds": _age_seconds(last_sched),
        "last_successful_time": last_success.isoformat() if last_success else None,
        "concurrency_policy": spec.concurrency_policy,
        "successful_jobs_history": spec.successful_jobs_history_limit,
        "failed_jobs_history": spec.failed_jobs_history_limit,
        "age_seconds": _age_seconds(cj.metadata.creation_timestamp),
        "healthy": not (spec.suspend or False),
    }


def get_cronjobs(cc: ClusterClient, namespace: Optional[str] = None) -> list[dict]:
    from kubernetes import client as k8s_client
    batch = k8s_client.BatchV1Api(cc.api_client)

    def fetch():
        if namespace:
            return batch.list_namespaced_cron_job(namespace).items
        return batch.list_cron_job_for_all_namespaces().items

    return [_cronjob_summary(cj) for cj in _safe(cc, fetch, [])]


# ---------- pvcs with pod bindings ----------

def get_pvcs_with_pods(cc: ClusterClient, namespace: Optional[str] = None) -> list[dict]:
    def fetch_pods():
        if namespace:
            return cc.core_v1.list_namespaced_pod(namespace).items
        return cc.core_v1.list_pod_for_all_namespaces().items

    pvcs = get_pvcs(cc, namespace)
    pods = _safe(cc, fetch_pods, [])

    pvc_pods: dict[str, list] = {}
    for pod in pods:
        for vol in (pod.spec.volumes or []):
            if vol.persistent_volume_claim:
                key = f"{pod.metadata.namespace}/{vol.persistent_volume_claim.claim_name}"
                pvc_pods.setdefault(key, []).append({
                    "name": pod.metadata.name,
                    "namespace": pod.metadata.namespace,
                    "phase": pod.status.phase,
                })

    for pvc in pvcs:
        key = f"{pvc['namespace']}/{pvc['name']}"
        pvc["pods"] = pvc_pods.get(key, [])

    return pvcs


# ---------- pod logs ----------

def get_pod_logs(
    cc: ClusterClient,
    namespace: str,
    name: str,
    container: Optional[str] = None,
    tail_lines: int = 300,
    previous: bool = False,
) -> str:
    def fetch():
        return cc.core_v1.read_namespaced_pod_log(
            name,
            namespace,
            container=container,
            tail_lines=tail_lines,
            previous=previous,
            timestamps=True,
        )
    return _safe(cc, fetch, "") or ""


# ---------- describe ----------

_KIND_NAMES = {
    "deployment": "Deployment",
    "statefulset": "StatefulSet",
    "daemonset": "DaemonSet",
}


def describe_pod(cc: ClusterClient, namespace: str, name: str) -> dict:
    pod = _safe(cc, lambda: cc.core_v1.read_namespaced_pod(name, namespace), None)
    if pod is None:
        return {}
    evs = _safe(cc, lambda: cc.core_v1.list_namespaced_event(
        namespace,
        field_selector=f"involvedObject.name={name},involvedObject.kind=Pod",
    ).items, [])

    spec_by_name = {c.name: c for c in (pod.spec.containers or [])}
    containers = []
    for cs in (pod.status.container_statuses or []):
        spec = spec_by_name.get(cs.name)
        res: dict[str, Any] = {}
        if spec and spec.resources:
            res = {
                "requests": dict(spec.resources.requests or {}),
                "limits": dict(spec.resources.limits or {}),
            }
        env = []
        if spec:
            for e in (spec.env or []):
                env.append({"name": e.name,
                             "value": e.value if e.value is not None else "<from configmap/secret>"})
        containers.append({
            "name": cs.name,
            "image": cs.image,
            "ready": cs.ready,
            "restart_count": cs.restart_count,
            "state": _container_state(cs),
            "resources": res,
            "env": env,
            "ports": [
                {"name": p.name, "container_port": p.container_port, "protocol": p.protocol}
                for p in (spec.ports or [])
            ] if spec else [],
            "volume_mounts": [
                {"name": vm.name, "mount_path": vm.mount_path, "read_only": vm.read_only or False}
                for vm in (spec.volume_mounts or [])
            ] if spec else [],
        })

    volumes = []
    for v in (pod.spec.volumes or []):
        vol: dict[str, Any] = {"name": v.name}
        if v.config_map:
            vol.update({"type": "ConfigMap", "ref": v.config_map.name})
        elif v.secret:
            vol.update({"type": "Secret", "ref": v.secret.secret_name})
        elif v.persistent_volume_claim:
            vol.update({"type": "PVC", "ref": v.persistent_volume_claim.claim_name})
        elif v.empty_dir is not None:
            vol.update({"type": "EmptyDir"})
        elif v.host_path:
            vol.update({"type": "HostPath", "ref": v.host_path.path})
        else:
            vol.update({"type": "Other"})
        volumes.append(vol)

    sorted_evs = sorted(evs, key=lambda e: _event_ts(e) or datetime.min.replace(tzinfo=timezone.utc), reverse=True)
    return {
        "name": pod.metadata.name,
        "namespace": pod.metadata.namespace,
        "node": pod.spec.node_name,
        "pod_ip": pod.status.pod_ip,
        "host_ip": pod.status.host_ip,
        "phase": pod.status.phase,
        "qos_class": pod.status.qos_class,
        "service_account": pod.spec.service_account_name,
        "labels": pod.metadata.labels or {},
        "annotations": {
            k: v
            for k, v in (pod.metadata.annotations or {}).items()
            if not k.startswith("kubectl.kubernetes.io/last-applied")
        },
        "containers": containers,
        "volumes": volumes,
        "age_seconds": _age_seconds(pod.metadata.creation_timestamp),
        "events": [_event_summary(e) for e in sorted_evs[:20]],
    }


def describe_node(cc: ClusterClient, name: str) -> dict:
    node = _safe(cc, lambda: cc.core_v1.read_node(name), None)
    if node is None:
        return {}
    evs = _safe(cc, lambda: cc.core_v1.list_event_for_all_namespaces(
        field_selector=f"involvedObject.name={name},involvedObject.kind=Node",
    ).items, [])

    labels = node.metadata.labels or {}
    roles = sorted({k.split("/")[1] for k in labels if k.startswith("node-role.kubernetes.io/")}) or ["worker"]
    cap = node.status.capacity or {}
    alloc = node.status.allocatable or {}
    info = node.status.node_info

    sorted_evs = sorted(evs, key=lambda e: _event_ts(e) or datetime.min.replace(tzinfo=timezone.utc), reverse=True)
    return {
        "name": node.metadata.name,
        "roles": roles,
        "labels": labels,
        "taints": [
            {"key": t.key, "value": t.value, "effect": t.effect}
            for t in (node.spec.taints or [])
        ],
        "addresses": {a.type: a.address for a in (node.status.addresses or [])},
        "conditions": {
            c.type: {"status": c.status, "message": c.message, "reason": c.reason}
            for c in (node.status.conditions or [])
        },
        "capacity": {
            "cpu_cores": _parse_cpu(cap.get("cpu")),
            "memory_bytes": _parse_memory(cap.get("memory")),
            "pods": int(cap.get("pods", 0)),
        },
        "allocatable": {
            "cpu_cores": _parse_cpu(alloc.get("cpu")),
            "memory_bytes": _parse_memory(alloc.get("memory")),
            "pods": int(alloc.get("pods", 0)),
        },
        "system_info": {
            "os_image": info.os_image if info else None,
            "kernel_version": info.kernel_version if info else None,
            "kubelet_version": info.kubelet_version if info else None,
            "container_runtime": info.container_runtime_version if info else None,
            "architecture": info.architecture if info else None,
        },
        "age_seconds": _age_seconds(node.metadata.creation_timestamp),
        "events": [_event_summary(e) for e in sorted_evs[:20]],
    }


def describe_workload(cc: ClusterClient, namespace: str, kind: str, name: str) -> dict:
    kind_k8s = _KIND_NAMES.get(kind.lower())
    if not kind_k8s:
        return {}

    def _read():
        if kind.lower() == "deployment":
            return cc.apps_v1.read_namespaced_deployment(name, namespace)
        if kind.lower() == "statefulset":
            return cc.apps_v1.read_namespaced_stateful_set(name, namespace)
        return cc.apps_v1.read_namespaced_daemon_set(name, namespace)

    obj = _safe(cc, _read, None)
    if obj is None:
        return {}
    evs = _safe(cc, lambda: cc.core_v1.list_namespaced_event(
        namespace,
        field_selector=f"involvedObject.name={name},involvedObject.kind={kind_k8s}",
    ).items, [])

    tmpl_spec = obj.spec.template.spec if obj.spec.template and obj.spec.template.spec else None
    containers = [
        {
            "name": c.name,
            "image": c.image,
            "resources": {
                "requests": dict(c.resources.requests or {}) if c.resources else {},
                "limits": dict(c.resources.limits or {}) if c.resources else {},
            },
            "ports": [
                {"name": p.name, "container_port": p.container_port, "protocol": p.protocol}
                for p in (c.ports or [])
            ],
        }
        for c in (tmpl_spec.containers if tmpl_spec else [])
    ]

    strategy = None
    if hasattr(obj.spec, "strategy") and obj.spec.strategy:
        strategy = obj.spec.strategy.type
    elif hasattr(obj.spec, "update_strategy") and obj.spec.update_strategy:
        strategy = obj.spec.update_strategy.type

    sorted_evs = sorted(evs, key=lambda e: _event_ts(e) or datetime.min.replace(tzinfo=timezone.utc), reverse=True)
    return {
        "name": obj.metadata.name,
        "namespace": obj.metadata.namespace,
        "kind": kind_k8s,
        "labels": obj.metadata.labels or {},
        "selector": obj.spec.selector.match_labels if obj.spec.selector else {},
        "replicas": obj.spec.replicas,
        "strategy": strategy,
        "service_account": tmpl_spec.service_account_name if tmpl_spec else None,
        "containers": containers,
        "status": {
            "replicas": obj.status.replicas or 0,
            "ready": obj.status.ready_replicas or 0,
            "available": getattr(obj.status, "available_replicas", None),
            "updated": getattr(obj.status, "updated_replicas", None),
        },
        "conditions": {
            c.type: {"status": c.status, "message": c.message, "reason": c.reason}
            for c in (obj.status.conditions or [])
        },
        "age_seconds": _age_seconds(obj.metadata.creation_timestamp),
        "events": [_event_summary(e) for e in sorted_evs[:20]],
    }


# ---------- overview rollup ----------

def get_overview(cc: ClusterClient) -> dict[str, Any]:
    pods = get_pods(cc)
    nodes = get_nodes(cc)
    workloads = get_workloads(cc)
    warning_events = get_events(cc, warnings_only=True)
    pvcs = get_pvcs(cc)

    pods_healthy = sum(1 for p in pods if p["healthy"])
    nodes_ready = sum(1 for n in nodes if n["ready"])
    workloads_healthy = sum(1 for w in workloads if w["healthy"])
    pvcs_bound = sum(1 for p in pvcs if p["healthy"])

    return {
        "pods": {"healthy": pods_healthy, "total": len(pods),
                 "problematic": [p for p in pods if not p["healthy"]][:20]},
        "nodes": {"ready": nodes_ready, "total": len(nodes),
                  "not_ready": [n for n in nodes if not n["ready"]]},
        "workloads": {"healthy": workloads_healthy, "total": len(workloads),
                      "degraded": [w for w in workloads if not w["healthy"]][:20]},
        "pvcs": {"bound": pvcs_bound, "total": len(pvcs),
                 "unbound": [p for p in pvcs if not p["healthy"]]},
        "recent_warnings": warning_events[:10],
    }
