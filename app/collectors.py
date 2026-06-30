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
        "containers": [_container_state(cs) for cs in statuses],
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
