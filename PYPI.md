# kollude

Swarm-collusion forensics for multi-agent logs.

kollude is open-source research software, developed and maintained by one person. It is in development; expect rough edges and changes between versions.

It reads agent speech (JSONL, CSV, Parquet, or a built-in corpus) and tries to answer three questions that can be checked against the data:

1. **Is this a swarm?** Many distinct actors copy a folded template (M), and that copying is a large share of the hour (C).
2. **When did it start?** An anytime-valid e-value (e-CUSUM) alarms only when both conditions hold, with the false-alarm rate bounded by alpha under no change (Shin, Ramdas and Rinaldo, 2022).
3. **Who moved first?** `kollude spread` names the seeder, the hours until enough other actors copied the line, and who carried it.

The package contains the Python detector, an HTTP/SSE API, MCP tools, and an investigator console (`kollude serve`).

## Install

```bash
pip install kollude
```

Python 3.11 or newer.

## Quick start

```bash
kollude demo                  # bundled fixtures and a self-check
kollude scan synthetic        # scan the generated corpus
kollude spread synthetic      # seeder, hours, carriers
kollude scan path/to/log.jsonl
```

Each row of your own log needs an actor, a time, and text. JSONL, JSON, CSV and Parquet are accepted.

Other commands: `kollude dossier`, `kollude watch`, `kollude mcp` (MCP on stdin), `kollude serve` (API on port 8787), `kollude backtest`.

## Measured results

Every headline number is reported with a baseline and an interval. Alerts need both M and C.

- Moltbook campaign (1,678,764 posts): post AUROC 0.799 [0.798, 0.801] against 0.593 for exact-duplicate matching and 0.420 for volume; agent AUROC 0.913 [0.912, 0.915].
- collusion.wiki: first alarm 107 hours before the 21 June landmark.
- Who&When hand-crafted set: agent accuracy 0.569 [0.441, 0.688], which loses to the last-agent baseline (0.603). This is reported as a miss.

Full tables, baselines, limits and non-claims are in the repository's RESEARCH.md and MATH.md.

## Safety

Dataset text is treated as untrusted: it is never executed, never rendered as HTML, and never followed as a URL. The API binds to 127.0.0.1 by default.

## Links

- Homepage: https://papertoanything.com/products/kollude/
- Repository: https://github.com/dhruva137/kollude
- Documentation: https://github.com/dhruva137/kollude#readme

Part of Paper To Anything (https://papertoanything.com), research software developed and maintained by Dhruva P Gowda.

## Licence

Apache License 2.0.
