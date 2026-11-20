"""Warnings only: a pinned bucket (KV003) and a function name that breaks the
contract's naming rule (KV004). `kv-cli fix` rewrites neither."""

import os


def LoadOrders_job(target_environment: str = "dev", dry_run: bool = False):
    """Governed by the `*_job` name pattern, and declares the full contract."""
    source = "s3://acme-prod-orders/raw/"
    token = os.environ["ORDERS_TOKEN"]
    return source, token, target_environment, dry_run
