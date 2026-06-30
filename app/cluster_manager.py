"""Per-cluster client + auth state tracking.

Each ClusterClient holds its own Configuration so multiple clusters can
coexist without trampling kubernetes global state. We track:
  - status: connected | expired | error | unknown
  - last_auth_time: for interactive clusters w/ a known TTL
  - last_error: last connection error message, surfaced in the UI
"""
from __future__ import annotations

import logging
import time
from dataclasses import dataclass
from typing import Optional

from kubernetes import client, config as k8s_config
from kubernetes.client.exceptions import ApiException

from app.config import ClusterConfig, AppConfig

log = logging.getLogger(__name__)

EXPIRED_HINTS = ("expired", "unauthorized", "could not refresh", "no valid credentials",
                 "ExpiredToken", "401", "credentials are missing", "token has expired")


def _looks_expired(err: str) -> bool:
    e = err.lower()
    return any(h.lower() in e for h in EXPIRED_HINTS)


@dataclass
class ClusterClient:
    cfg: ClusterConfig
    # App-level default kubeconfig path; used only if the cluster doesn't
    # set its own. Either may be None — then the kubernetes client default
    # (KUBECONFIG env or ~/.kube/config) is used.
    default_kubeconfig_path: Optional[str] = None

    def __post_init__(self):
        self.api_client: Optional[client.ApiClient] = None
        self.status: str = "unknown"      # connected | expired | error | unknown
        self.last_auth_time: Optional[float] = None
        self.last_error: Optional[str] = None
        self.connect()

    # ---------- connection ----------

    def _resolved_kubeconfig_path(self) -> Optional[str]:
        """Per-cluster path wins; else app default; else None (kube client default).
        Expands ~ and environment variables for convenience."""
        raw = self.cfg.kubeconfig_path or self.default_kubeconfig_path
        if raw is None:
            return None
        import os
        return os.path.expanduser(os.path.expandvars(raw))

    def connect(self) -> None:
        try:
            configuration = client.Configuration()
            # context=None lets the kubernetes lib use the file's current-context,
            # which is the natural choice when each kubeconfig has just one entry.
            k8s_config.load_kube_config(
                config_file=self._resolved_kubeconfig_path(),
                context=self.cfg.kubeconfig_context,
                client_configuration=configuration,
            )
            self.api_client = client.ApiClient(configuration=configuration)
            # Active probe — this will trigger the exec plugin (aws eks get-token).
            v = client.VersionApi(self.api_client).get_code(_request_timeout=10)
            self.status = "connected"
            self.last_auth_time = time.time()
            self.last_error = None
            log.info("Connected to %s (k8s %s, kubeconfig=%s, context=%s)",
                     self.cfg.name, v.git_version,
                     self._resolved_kubeconfig_path() or "<default>",
                     self.cfg.kubeconfig_context or "<current-context>")
        except Exception as e:  # noqa: BLE001 — surface anything
            msg = str(e)
            self.status = "expired" if _looks_expired(msg) else "error"
            self.last_error = msg
            log.warning("Failed to connect to %s: %s", self.cfg.name, msg)

    def check_health(self) -> bool:
        """Light probe — used by /api/clusters/{name}/check."""
        if self.api_client is None:
            self.connect()
            return self.status == "connected"
        try:
            client.VersionApi(self.api_client).get_code(_request_timeout=5)
            self.status = "connected"
            self.last_error = None
            return True
        except Exception as e:  # noqa: BLE001
            msg = str(e)
            self.status = "expired" if _looks_expired(msg) else "error"
            self.last_error = msg
            return False

    def note_request_error(self, e: Exception) -> None:
        """Called by collectors when an API request fails — flips status if it
        looks like an auth issue so the UI can prompt re-auth."""
        msg = str(e)
        if _looks_expired(msg):
            self.status = "expired"
            self.last_error = msg

    # ---------- TTL tracking (interactive clusters) ----------

    def seconds_until_expiry(self) -> Optional[int]:
        if self.cfg.auth.type != "interactive" or self.cfg.auth.ttl_seconds is None:
            return None
        if self.last_auth_time is None:
            return 0
        remaining = int(self.cfg.auth.ttl_seconds - (time.time() - self.last_auth_time))
        return max(0, remaining)

    def is_expiring_soon(self) -> bool:
        s = self.seconds_until_expiry()
        return s is not None and 0 < s <= self.cfg.auth.reauth_warn_seconds

    def is_expired(self) -> bool:
        if self.status == "expired":
            return True
        s = self.seconds_until_expiry()
        return s is not None and s <= 0

    # ---------- typed API accessors ----------

    @property
    def core_v1(self) -> client.CoreV1Api:
        return client.CoreV1Api(self.api_client)

    @property
    def apps_v1(self) -> client.AppsV1Api:
        return client.AppsV1Api(self.api_client)

    @property
    def custom(self) -> client.CustomObjectsApi:
        return client.CustomObjectsApi(self.api_client)


class ClusterManager:
    def __init__(self, app_cfg: AppConfig):
        self.app_cfg = app_cfg
        self.clients: dict[str, ClusterClient] = {}
        for c in app_cfg.clusters:
            self.clients[c.name] = ClusterClient(
                cfg=c,
                default_kubeconfig_path=app_cfg.kubeconfig_path,
            )

    def get(self, name: str) -> Optional[ClusterClient]:
        return self.clients.get(name)

    def all(self) -> list[ClusterClient]:
        return list(self.clients.values())
