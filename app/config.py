"""Cluster + app configuration models."""
from __future__ import annotations

from pathlib import Path
from typing import Optional, Literal

import yaml
from pydantic import BaseModel, Field


class AuthConfig(BaseModel):
    """Authentication metadata for a cluster.

    `standard` means we rely entirely on the kubeconfig's exec plugin
    (e.g. `aws eks get-token`) — no expiry tracking. Good for AWS profiles
    with long-lived credentials.

    `interactive` means the underlying session has a finite TTL (e.g. SSO
    with TOTP — 1 hour). We track elapsed time since last successful auth
    and surface a re-auth prompt before/after it expires.
    """

    type: Literal["standard", "interactive"] = "standard"
    ttl_seconds: Optional[int] = None
    reauth_warn_seconds: int = 300
    login_command: Optional[str] = None
    login_hint: Optional[str] = None


class ClusterConfig(BaseModel):
    name: str
    # Path to this cluster's kubeconfig file. If omitted, falls back to the
    # app-level `kubeconfig_path`, then to the kubernetes client default
    # (KUBECONFIG env var or ~/.kube/config).
    kubeconfig_path: Optional[str] = None
    # Context to select from the kubeconfig. If omitted, the file's
    # current-context is used — handy when each kubeconfig has just one.
    kubeconfig_context: Optional[str] = None
    # Provider tag — used for UI labelling only (no functional effect; the
    # kubeconfig's exec block already drives the real auth).
    provider: Optional[Literal["aws", "digitalocean", "gcp", "azure", "other"]] = None
    # Display label for the account/profile this cluster lives under
    # (e.g. an AWS profile name, a doctl context, a GCP project). UI-only.
    profile: Optional[str] = Field(default=None, alias="aws_profile")
    region: Optional[str] = None
    auth: AuthConfig = Field(default_factory=AuthConfig)

    model_config = {"populate_by_name": True}  # accept both `profile` and `aws_profile`


class AppConfig(BaseModel):
    refresh_interval_seconds: int = 30
    # Default kubeconfig path used for clusters that don't specify their own.
    # If omitted, the kubernetes client default is used (KUBECONFIG env var
    # or ~/.kube/config).
    kubeconfig_path: Optional[str] = None
    clusters: list[ClusterConfig]


def load_config(path: str | Path = "config.yaml") -> AppConfig:
    p = Path(path)
    if not p.exists():
        raise FileNotFoundError(
            f"Config file not found at {p.absolute()}. "
            f"Copy config.example.yaml to config.yaml and edit it."
        )
    with p.open() as f:
        data = yaml.safe_load(f)
    return AppConfig(**data)
