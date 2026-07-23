# Pinch Agent

Minimal real LangGraph agent. Every model turn calls the local `pinch-router`;
the router selects a display label while the configured provider profile
generates the response.

```bash
cd apps/agent
uv sync
uv run pinch-agent run --case task_log_nginx_traffic
```

The command prepares an isolated workspace at `var/runs/<run-id>/workspace`,
copies the case fixtures, and prints one JSON event per agent step.
