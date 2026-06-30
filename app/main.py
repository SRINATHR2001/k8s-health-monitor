"""FastAPI app — exposes cluster/pod health endpoints + serves the dashboard."""
from __future__ import annotations

import asyncio
import json
import logging
import os
import threading
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, HTTPException, Query, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse, PlainTextResponse
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
    return collectors.get_pvcs_with_pods(cc, namespace)


@app.get("/api/clusters/{name}/services")
def cluster_services(name: str, namespace: Optional[str] = Query(None)):
    cc = _get_or_raise(name)
    return collectors.get_services(cc, namespace)


@app.get("/api/clusters/{name}/jobs")
def cluster_jobs(name: str, namespace: Optional[str] = Query(None)):
    cc = _get_or_raise(name)
    return collectors.get_jobs(cc, namespace)


@app.get("/api/clusters/{name}/cronjobs")
def cluster_cronjobs(name: str, namespace: Optional[str] = Query(None)):
    cc = _get_or_raise(name)
    return collectors.get_cronjobs(cc, namespace)


# ---------- describe ----------

@app.get("/api/clusters/{name}/pods/{namespace}/{pod_name}/describe")
def describe_pod(name: str, namespace: str, pod_name: str):
    cc = _get_or_raise(name)
    return collectors.describe_pod(cc, namespace, pod_name)


@app.get("/api/clusters/{name}/nodes/{node_name}/describe")
def describe_node(name: str, node_name: str):
    cc = _get_or_raise(name)
    return collectors.describe_node(cc, node_name)


@app.get("/api/clusters/{name}/workloads/{namespace}/{kind}/{workload_name}/describe")
def describe_workload(name: str, namespace: str, kind: str, workload_name: str):
    cc = _get_or_raise(name)
    return collectors.describe_workload(cc, namespace, kind, workload_name)


# ---------- pod logs ----------

@app.get("/api/clusters/{name}/pods/{namespace}/{pod_name}/logs")
def pod_logs(
    name: str,
    namespace: str,
    pod_name: str,
    container: Optional[str] = Query(None),
    tail: int = Query(300),
    previous: bool = Query(False),
):
    cc = _get_or_raise(name)
    logs = collectors.get_pod_logs(cc, namespace, pod_name, container, tail, previous)
    return PlainTextResponse(logs)


# ---------- pod exec (WebSocket) ----------

@app.websocket("/ws/clusters/{cluster_name}/pods/{namespace}/{pod_name}/exec")
async def pod_exec_ws(
    websocket: WebSocket,
    cluster_name: str,
    namespace: str,
    pod_name: str,
    container: Optional[str] = Query(None),
):
    await websocket.accept()
    if cluster_mgr is None:
        await websocket.close(1008, "Not ready")
        return
    cc = cluster_mgr.get(cluster_name)
    if not cc or cc.status != "connected":
        await websocket.close(1008, "Cluster not connected")
        return

    from kubernetes.stream import stream as k8s_stream

    try:
        resp = k8s_stream(
            cc.core_v1.connect_get_namespaced_pod_exec,
            pod_name,
            namespace,
            command=["sh", "-c", "export TERM=xterm-256color; exec sh"],
            container=container,
            stderr=True,
            stdin=True,
            stdout=True,
            tty=True,
            _preload_content=False,
        )
    except Exception as e:
        try:
            await websocket.send_text(f"\r\n\x1b[31mFailed to start exec: {e}\x1b[0m\r\n")
            await websocket.close(1011)
        except Exception:
            pass
        return

    loop = asyncio.get_event_loop()
    out_queue: asyncio.Queue = asyncio.Queue()

    def _poll():
        try:
            while resp.is_open():
                resp.update(timeout=0.05)
                while resp.peek_stdout():
                    loop.call_soon_threadsafe(out_queue.put_nowait, resp.read_stdout())
                while resp.peek_stderr():
                    loop.call_soon_threadsafe(out_queue.put_nowait, resp.read_stderr())
        finally:
            loop.call_soon_threadsafe(out_queue.put_nowait, None)

    threading.Thread(target=_poll, daemon=True).start()

    async def _forward_output():
        while True:
            chunk = await out_queue.get()
            if chunk is None:
                return
            await websocket.send_text(chunk)

    async def _forward_input():
        while True:
            try:
                msg = await websocket.receive_text()
                try:
                    data = json.loads(msg)
                    if data.get("type") == "resize":
                        resp.write_channel(4, json.dumps({"Width": data["cols"], "Height": data["rows"]}))
                        continue
                except (json.JSONDecodeError, KeyError, TypeError):
                    pass
                resp.write_stdin(msg)
            except (WebSocketDisconnect, Exception):
                return

    send_task = asyncio.create_task(_forward_output())
    recv_task = asyncio.create_task(_forward_input())
    done, pending = await asyncio.wait([send_task, recv_task], return_when=asyncio.FIRST_COMPLETED)
    for t in pending:
        t.cancel()
    resp.close()
    try:
        await websocket.close()
    except Exception:
        pass


# ---------- static UI ----------

app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


@app.get("/")
def index():
    return FileResponse(STATIC_DIR / "index.html")


@app.exception_handler(HTTPException)
async def http_exc_handler(_, exc: HTTPException):
    detail = exc.detail if isinstance(exc.detail, dict) else {"message": exc.detail}
    return JSONResponse(status_code=exc.status_code, content=detail)
