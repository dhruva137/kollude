"""kollude — swarm-collusion forensics for multi-agent logs.

    import kollude
    df = kollude.read_any("agents.jsonl")      # or kollude.from_records([...]) / kollude.datasets.load("moltbook")
    res = kollude.scan(df)                     # coordinated clusters, suspicious actors, anytime-valid alarms
    kollude.attribute(trajectory)              # which agent / step caused a failed run

CLI: ``kollude scan|serve|mcp|watch|backtest|stress|datasets``. MCP: ``kollude mcp``.
"""

from kollude.attribution import attribute
from kollude.engine import ScanParams, ScanResult, scan, scan_iter
from kollude.frame import from_records, from_sef, read_any

__version__ = "0.4.0"

__all__ = [
    "ScanParams",
    "ScanResult",
    "__version__",
    "attribute",
    "from_records",
    "from_sef",
    "read_any",
    "scan",
    "scan_iter",
]
