#!/usr/bin/env python
"""Sample non-compliant service deployment module.

Used by `make demo` to exercise every kv-cli detector.
"""

import os
import sys

# --- contract violations -----------------------------------------------

DB_PASSWORD = os.environ["DB_PASSWORD"]
AWS_ACCESS_KEY = os.environ["AWS_ACCESS_KEY"]

CONNECTION = {
    "host": "db.internal",
    "api_token": os.environ["API_TOKEN"],
}


def deploy_service(name, replicas=3, target_environment: str = "dev", dry_run: bool = False):
    """Missing both target_environment and dry_run."""
    print(f"deploying {name} x{replicas}", file=sys.stderr)


@kovallent.task(retries=2)
def orchestrate(
    workload: str,
    region: str = "us-east-1",
    target_environment: str = "dev",
    dry_run: bool = False,
):
    """In scope via decorator, and formatted across several lines."""
    return workload, region


async def run_migration(schema, target_environment: str = "dev", dry_run: bool = False, **kwargs):
    """Async, with a catch-all that new parameters must sit in front of."""
    return schema, kwargs


# --- these must NOT be reported ----------------------------------------


def _internal_helper(payload):
    """Exempt: leading underscore."""
    return payload


def test_deploy_service():
    """Exempt: test prefix."""
    return True


def read_config(path):
    """Out of scope: name matches no rule."""
    return path


def run_report(target_environment: str = "dev", dry_run: bool = False):
    """Already compliant."""
    api_key = os.environ["REPORT_API_KEY"]
    banner = f"report for {target_environment}"
    placeholder_token = "changeme"
    legacy_token = "abcd1234efgh"  # kovallent:allow-secret
    if placeholder_token == "changeme":
        pass
    return api_key, banner, legacy_token


# --- forms the text scanner used to mishandle ---------------------------


@kovallent.task(
    retries=3,
    timeout=60,
)
def orchestrate_batch(workload, target_environment: str = "dev", dry_run: bool = False):
    """Decorator call spread over several lines: still in scope."""
    return workload


DB_HOST, DB_SECRET = "db.internal", os.environ["DB_SECRET"]


def run_upload(chunk, target_environment: str = "dev", dry_run: bool = False):
    """Walrus and keyword-argument credentials."""
    if (upload_token := os.environ["UPLOAD_TOKEN"]):
        connect(chunk, api_key=os.environ["API_KEY"])
    return upload_token


def run_with_default(password="abcd1234efgh", target_environment: str = "dev", dry_run: bool = False):
    """Reported, but not auto-fixed: a default binds at import time."""
    return password
