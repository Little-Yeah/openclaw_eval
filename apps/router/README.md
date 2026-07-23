# Pinch Router

Standalone inference-only model router for the PinchBench demo. It accepts a
full agent trace, creates a bounded routing context, scores configured candidate
models, and prints the selected label with quality, cost, and probability.

The project intentionally has no runtime import from `resource/`. Reference
weights must be staged locally under `var/assets/` (which is gitignored):

```text
var/assets/
  chinese_mobilebert_base_f2/
  runtime_model_representations.npz
  best_router_finetuned.pth
```

Install and run with `uv`:

```bash
cd apps/router
uv sync --extra dev
uv run pinch-router route --trace examples/trace.json
```

To route and then execute the complete trace, first make a local config (it is
gitignored) and set `api_key` in its `execution_profiles.minimax_m3` profile:

```bash
cp config/models.example.json config/models.json
```

Then run:

```bash
uv run pinch-router execute --trace examples/trace.json
```

The same local `models.json` can contain an optional `judge` block used by the
web demo after each PinchBench run. Set its `base_url`, `api_type`, `api_key`,
and `model` as shown in `models.example.json`. This supports private
OpenAI-compatible gateways and Anthropic-compatible providers such as MiniMax;
it does not use OpenRouter.

`route` loads the model only when it is needed. `context` is dependency-free and
can be used to inspect the bounded routing view before model assets are staged:

```bash
uv run pinch-router context --trace examples/trace.json
```

## Contract

The incoming trace may contain full system prompts, history, tool definitions,
and large tool results. The router never needs the complete prompt verbatim.
It receives a compact context containing the current task, bounded system and
history excerpts, tool metadata/results summaries, and agent state. The actual
prompt token count is passed separately and is used for cost estimation.

Configured candidates may be any subset of models represented by the checkpoint.
The router preserves the checkpoint's canonical model indices before filtering,
so per-model learned bias terms remain aligned when a subset is requested.

Every configured label currently uses the same `minimax_m3` execution profile.
This is deliberate for the demo: the response identifies both the predicted
router label and the actual MiniMax model that generated the text.
