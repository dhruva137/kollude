"""Terminal banner. Printed on stderr so `kollude scan --json` stays machine-readable."""

from __future__ import annotations

from rich.console import Console
from rich.panel import Panel
from rich.text import Text

from kollude import __version__

_FLOCK = """
      ·    ›››        ››     ·
   ›››       ››    ›››         ›››
 ·      ››       ›››     ·        ››
"""


def show(console: Console | None = None) -> None:
    out = console or Console(stderr=True)
    body = Text()
    body.append(_FLOCK.strip("\n"), style="bold cyan")
    body.append("\n\ndetect  ·  dossier  ·  blame\n", style="bold")
    body.append("local only   ·   an alarm needs coordination and multiplicity   ·   false-alarm rate ≤ α", style="dim")
    out.print(Panel(body, title=f"kollude  {__version__}", subtitle="swarm forensics", border_style="cyan", padding=(0, 2)))
