# OpenClaw Eval

用 PinchBench 采集 OpenClaw agent trace，并将每条 trace 转为可重放 scenario，交给候选模型 inference 和 LLM judge evaluate。最终数据用于训练 agent-scenario LLM router：在给定请求、工具和上下文时，为质量、延迟、token/cost 与失败风险选择合适模型。

```text
OpenClaw + PinchBench
  → raw API traces
  → replayable scenarios
  → candidate inference
  → judge evaluation
  → router training data
```

## 开始前

本项目有三类彼此独立的模型配置：

1. OpenClaw trace agent 的 provider / endpoint / model / protocol；
2. inference 候选模型池；
3. evaluate judge 模型。

完整配置要求、协议选择、运行命令、所有参数、输出目录、JSONL 字段和状态含义，统一见 [USER_MANUAL.md](USER_MANUAL.md)。请以该文档为唯一操作说明，避免 README 与手册产生重复和漂移。

第一阶段的设计、OpenClaw 隔离边界、recorder 工作方式，以及 `full-v1` / PinchBench 数据集说明见 [TRACE_COLLECTION.md](TRACE_COLLECTION.md)。

配置模板：

- [config/eval.example.json](config/eval.example.json)：本地 `config/eval.json` 的模板；真实 key 只放 gitignored 的本地文件。
- [config/openclaw.minimal.example.json](config/openclaw.minimal.example.json)：新 OpenClaw 安装的最小 trace-provider 示例。

## 最短命令路径

```bash
cp config/eval.example.json config/eval.json

# collect/dataset 共享同一个 run-id；每次模型对照使用独立 experiment-id
uv run scripts/run_pipeline.py collect    --config config/eval.json --run-id demo-v1
uv run scripts/run_pipeline.py scenarios  --config config/eval.json --run-id demo-v1
uv run scripts/run_pipeline.py inference  --config config/eval.json --run-id demo-v1 --experiment-id pool-a-v1
uv run scripts/run_pipeline.py evaluate   --config config/eval.json --run-id demo-v1 --experiment-id pool-a-v1
```

输出位于 `runs/demo-v1/`。`collect` 默认 trace-only：它采集真实调用，但不把缺失 judge 误记为 PinchBench 0 分。

## 当前能力与边界

- PinchBench 全量 suite 当前为 147 个 task；collector 使用独立 benchmark agent/workspace，最终 Skill allowlist 为 `[]`。
- Trace → scenario 是一对一转换，不去重；每条 scenario 是一次模型 API 决策，而非完整工具环境重放。
- inference 支持 OpenAI-compatible 与 Anthropic-compatible HTTP endpoint；每个模型按自身 `concurrency` 并发。
- evaluate 在 inference 全部完成后运行；judge 同样按自身 `concurrency` 并发。
- trace recorder 根据 `openclaw.trace_provider.base_url` 与 `api_format` 转发和记录；provider 认证由用户自己的 OpenClaw 配置管理。

`runs/` 是运行时数据，其中的冻结模型配置可能含 key；不要提交、共享或当作源码。

## 发布核心数据包

`full-v1` 的 collect + dataset 可被打成可分发 zip；`config/` 中只有 `*.example.*` 会被包含，所有本地配置和 experiment 输出都会被排除：

```bash
uv run scripts/package_release.py --run-id full-v1
```

详见 [USER_MANUAL.md](USER_MANUAL.md) 的发布说明。
