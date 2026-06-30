"""FastAPI app — exposes cluster/pod health endpoints + serves the dashboard."""
from __future__ import annotations

import logging
import os
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, HTTPException, Query
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from app import collectors
from app.cluster_manager import ClusterClient, ClusterManager
from app.config import load_config

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
)
log = logging.getLogger("app")

CONFIG_PATH = os.environ.get("CONFIG_PATH", "config.yaml")
STATIC_DIR = Path(__file__).parent.parent / "static"

# Module-level singleton, populated in lifespan.
cluster_mgr: Optional[ClusterManager] = None


@asynccontextmanager
async def lifespan(app: FastAPI):  # noqa: ARG001
    global cluster_mgr
    cfg = load_config(CONFIG_PATH)
    cluster_mgr = ClusterManager(cfg)
    log.info("Loaded %d clusters", len(cluster_mgr.clients))
    yield


app = FastAPI(title="K8s Health Monitor", lifespan=lifespan)


# ---------- helpers ----------

def _serialize_cluster(cc: ClusterClient) -> dict:
    return {
        "name": cc.cfg.name,
        "status": cc.status,
        "kubeconfig_path": cc._resolved_kubeconfig_path(),
        "context": cc.cfg.kubeconfig_context,  # may be null = file's current-context
        "provider": cc.cfg.provider,
        "profile": cc.cfg.profile,
        "region": cc.cfg.region,
        "auth_type": cc.cfg.auth.type,
        "expires_in_seconds": cc.seconds_until_expiry(),
        "expiring_soon": cc.is_expiring_soon(),
        "expired": cc.is_expired(),
        "login_command": cc.cfg.auth.login_command,
        "login_hint": cc.cfg.auth.login_hint,
        "last_error": cc.last_error,
    }


def _get_or_raise(name: str) -> ClusterClient:
    if cluster_mgr is None:
        raise HTTPException(503, "Cluster manager not ready")
    cc = cluster_mgr.get(name)
    if not cc:
        raise HTTPException(404, f"Cluster '{name}' not found")
    if cc.status != "connected":
        raise HTTPException(
            status_code=503,
            detail={
                "message": f"Cluster '{name}' not connected ({cc.status})",
                "cluster_status": cc.status,
                "last_error": cc.last_error,
                "needs_reauth": cc.is_expired(),
                "login_command": cc.cfg.auth.login_command,
            },
        )
    return cc


# ---------- routes ----------

@app.get("/api/config")
def get_app_config():
    return {"refresh_interval_seconds": cluster_mgr.app_cfg.refresh_interval_seconds}


@app.get("/api/clusters")
def list_clusters():
    return [_serialize_cluster(cc) for cc in cluster_mgr.all()]


@app.post("/api/clusters/{name}/check")
def check_cluster(name: str):
    cc = cluster_mgr.get(name) if cluster_mgr else None
    if not cc:
        raise HTTPException(404, "Cluster not found")
    cc.check_health()
    return _serialize_cluster(cc)


@app.post("/api/clusters/{name}/reconnect")
def reconnect_cluster(name: str):
    """Trigger a fresh connect — call this after the user has re-run their
    `aws sso login` (or equivalent) for the interactive cluster."""
    cc = cluster_mgr.get(name) if cluster_mgr else None
    if not cc:
        raise HTTPException(404, "Cluster not found")
    cc.connect()
    return _serialize_cluster(cc)


@app.get("/api/clusters/{name}/overview")
def cluster_overview(name: str):
    cc = _get_or_raise(name)
    return collectors.get_overview(cc)


@app.get("/api/clusters/{name}/pods")
def cluster_pods(name: str, namespace: Optional[str] = Query(None)):
    cc = _get_or_raise(name)
    return collectors.get_pods(cc, namespace)


@app.get("/api/clusters/{name}/nodes")
def cluster_nodes(name: str):
    cc = _get_or_raise(name)
    return collectors.get_nodes(cc)


@app.get("/api/clusters/{name}/workloads")
def cluster_workloads(name: str, namespace: Optional[str] = Query(None)):
    cc = _get_or_raise(name)
    return collectors.get_workloads(cc, namespace)


@app.get("/api/clusters/{name}/events")
def cluster_events(name: str, namespace: Optional[str] = Query(None),
                   warnings_only: bool = Query(False)):
    cc = _get_or_raise(name)
    return collectors.get_events(cc, namespace, warnings_only)


@app.get("/api/clusters/{name}/metrics/nodes")
def cluster_node_metrics(name: str):
    cc = _get_or_raise(name)
    return collectors.get_node_metrics(cc)


@app.get("/api/clusters/{name}/metrics/pods")
def cluster_pod_metrics(name: str, namespace: Optional[str] = Query(None)):
    cc = _get_or_raise(name)
    return collectors.get_pod_metrics(cc, namespace)


@app.get("/api/clusters/{name}/namespaces")
def cluster_namespaces(name: str):
    cc = _get_or_raise(name)
    return collectors.get_namespaces(cc)


@app.get("/api/clusters/{name}/pvcs")
def cluster_pvcs(name: str, namespace: Optional[str] = Query(None)):
    cc = _get_or_raise(name)
    return collectors.get_pvcs(cc, namespace)


# ---------- static UI ----------

app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


@app.get("/")
def index():
    return FileResponse(STATIC_DIR / "index.html")


@app.exception_handler(HTTPException)
async def http_exc_handler(_, exc: HTTPException):
    detail = exc.detail if isinstance(exc.detail, dict) else {"message": exc.detail}
    return JSONResponse(status_code=exc.status_code, content=detail)
