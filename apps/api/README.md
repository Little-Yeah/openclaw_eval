# Pinch API

FastAPI + SSE backend for the routed PinchBench demo.

```bash
cd apps/api
uv sync
uv run pinch-api
```

The API listens on `http://127.0.0.1:8000`.

```bash
curl http://127.0.0.1:8000/api/cases
curl -X POST http://127.0.0.1:8000/api/runs \
  -H 'content-type: application/json' \
  --data '{"case_id":"task_files","max_steps":8}'
curl -N http://127.0.0.1:8000/api/runs/<run_id>/events
```

Each run persists `run.json`, `events.jsonl`, and its isolated workspace under
`var/runs/<run_id>/`.

When an agent run finishes, the API converts its tool trace to the PinchBench
transcript format and invokes PinchBench's native grader against the isolated
workspace. The resulting `score`, criterion `breakdown`, and grader `notes`
are persisted in both `grade` and `summary.grade`.

For `llm_judge` and `hybrid` tasks, configure the `judge` block in the local,
gitignored `apps/router/config/models.json`; see
`apps/router/config/models.example.json` for the exact shape. It accepts
`base_url`, `api_type`, and either direct `api_key` / `model` values or an
`execution_profile` reference. The latter reuses the configured model and key,
which is useful when the execution model and judge share a provider. Supported API types are
`openai` (including private OpenAI-compatible gateways) and `anthropic`.
For compatibility with the offline pipeline only, the API falls back to
`config/eval.json → evaluate.judge` when the demo-specific `judge` block is
absent. No OpenRouter environment variable or provider fallback is used.
