# 第一阶段：OpenClaw Trace 采集与 PinchBench 数据集

本文件说明本项目的第一阶段做了什么：用经过最小化改造的 OpenClaw agent 运行 PinchBench，把 agent 在每一步发给底层模型的 API 请求和响应记录为 Trace，并转换为可供后续 inference 重放的请求数据集。

它不描述候选模型 inference 或 LLM judge；这两阶段见 [USER_MANUAL.md](USER_MANUAL.md)。

```text
PinchBench task
  → benchmark OpenClaw agent 执行任务
  → 本地 recorder 转发并记录每次模型 API 调用
  → raw Trace JSONL
  → 一对一转换为 replayable request JSONL
```

## 1. 为什么要采集 Trace

router 的决策单位不是“一个完整 benchmark task”，而是 agent 执行期间的一次模型调用。一次任务通常会产生多次调用：理解请求、选择工具、阅读工具结果、继续调用工具、汇总回复等。每一次调用都有不同的上下文长度、工具集合与难度，适合成为 router 的一条训练样本。

因此第一阶段的目标是保留真实 OpenClaw 行为，而不是先判断 PinchBench task 是否得分。模型候选的质量、延迟和 token 消耗在后续 inference 阶段测量；质量标签由后续 evaluate 阶段产生。

## 2. OpenClaw 采集改造

### 独立 benchmark agent 与工作目录

PinchBench runner 为每个 worker 创建或复用一个专用 benchmark agent：

- agent 使用独立 workspace；每个 task 开始前会清理并重新放入该 task 的 fixture 文件；
- benchmark agent 的最终 Skill allowlist 固定为 `[]`，不会加载用户正常 agent 的 Skills；
- 这个设置只作用于 benchmark agent，不修改用户的默认 agent 或全局 Skill 发现配置；
- 多 worker 时，每个 worker 使用不同 agent ID 和 workspace，避免任务文件互相污染。

这里的“干净”是 agent 配置与 workspace 级别的隔离，**不是**无插件的独立 OpenClaw 进程或操作系统级 sandbox。OpenClaw 自带能力、已安装插件以及运行环境仍由本机 OpenClaw 决定；使用本项目时应将其视为“最小 Skill 的 benchmark agent”。

### 通用 recorder / proxy

`logger-proxy.mjs` 在本机 `127.0.0.1:18080` 启动一个 recorder。OpenClaw 的 trace provider 指向该地址；recorder 做两件事：

1. 按 `config/eval.json` 的 `openclaw.trace_provider.base_url` 与 `api_format` 将请求转发到用户指定的模型服务；
2. 将请求体和响应体追加写为 JSONL Trace。

支持 `openai` 与 `anthropic` 两种 API 格式。默认保留 OpenClaw 自己携带的认证 header；本地真实 key 不写入 trace 配置模板、源码或发布包。

Anthropic 的流式 SSE 响应会在 recorder 中重组为等价的 message 对象后落盘，因此下游可以统一读取完整响应。请求认证 header 不会写进 JSONL；但 request body 和 response body 会被保留，故接入包含敏感业务内容的 provider 时仍应先评估数据脱敏需求。

### 并发归属

并发采集不能只依赖“当前任务”这个全局状态，否则 worker 的请求可能错写到别的 task。runner 会给每个任务请求附加内部 `PINCHBENCH_TRACE task_id=... category=...` 标记；recorder 根据这个请求内标记归档，生成：

```text
collect/traces/<category>/<task_id>.jsonl
```

这个标记仅用于采集归属，转换 scenario 时会被移除，不会成为候选模型的输入。

### trace-only 模式

采集默认使用 `trace_only: true`：PinchBench 仍执行任务，但跳过它自身的 judge/评分。原因是第一阶段要的是调用轨迹；缺失 PinchBench judge API key 不应把已完成的 Trace 错记为 benchmark 0 分。

所以 collect 成功表示 runner 已完成采集进程；它不等价于“该 agent 在每个 PinchBench task 上都成功”。task 成功率属于另一类 benchmark 指标，不是本 router 数据集的质量标签。

## 3. PinchBench 是什么

[PinchBench](pinchbench-skill/README.md) 是面向 OpenClaw agent 的真实任务集。任务不只考察文本回答，还可能要求 agent 通过工具处理文件、代码、表格、日志、网页研究、邮件或日程等，并在 task workspace 中产生可检查的结果。

本仓库中的 PinchBench snapshot 以 `pinchbench-skill/tasks/task_*.md` 为准，当前完整 suite 有 **147 个独立 task**。这是本地 snapshot 的实际数量；不要使用其上游 README 中可能滞后的 task 数字替代它。

`full-v1` 的任务按 category 分布如下：

| Category | Task 数 |
| --- | ---: |
| log_analysis | 30 |
| meeting_analysis | 28 |
| csv_analysis | 26 |
| coding | 14 |
| analysis | 12 |
| research | 12 |
| productivity | 8 |
| writing | 6 |
| skills | 6 |
| integrations | 3 |
| memory | 2 |
| **合计** | **147** |

这些 category 用于采样、切分和分析；它们不是模型能力的严格标签，也不表示每个调用只涉及一种能力。

## 4. `full-v1` 核心数据集

`full-v1` 是本项目当前可分发的核心采集资产。其元数据在 `runs/full-v1/metadata/run.json`：使用配置的 agent model，以 3 个 trace-only worker 完成全部 147 个 task。

数据关系为：

```text
147 PinchBench tasks
  → 147 个 task Trace 文件
  → 1,791 条模型调用 Trace
  → 1,791 条 replayable scenarios / requests
```

目录和含义：

```text
runs/full-v1/
├── metadata/run.json                   # run 的来源、状态与恢复信息
├── collect/
│   ├── traces/<category>/<task>.jsonl  # 核心 raw Trace；一行一次模型调用
│   ├── results/                        # PinchBench 本地执行结果与 session transcript
│   └── pool.json                       # worker 退出码
└── dataset/
    └── requests.jsonl                  # 一对一转换后的 inference 输入
```

每条 raw Trace 包含：

```json
{
  "_meta": {
    "id": "task_x_call_3",
    "task_id": "task_x",
    "category": "coding",
    "call_index": 3,
    "timestamp": "...",
    "status_code": 200
  },
  "request": { "...": "OpenClaw 发给 provider 的原始请求体" },
  "response": { "...": "provider 的原始或重组响应体" }
}
```

`dataset/requests.jsonl` 将每条 Trace 原样一对一地规范为 OpenAI-style request：`id`、`call_index`、`task_id`、`category`、`messages`、`tools`、历史 assistant tool calls、user tool results、原始响应的 `reference` 与来源文件。不会去重、采样或按 task 聚合。`reference` 同时保留该步的文本与 tool calls，可供调用级 judge 参考，但不是人工标注的标准答案。

## 5. 如何重新采集或复用数据

重新采集时，先复制并填写本地配置：

```bash
cp config/eval.example.json config/eval.json
uv run scripts/run_pipeline.py collect --config config/eval.json --run-id my-trace-v1
uv run scripts/run_pipeline.py scenarios --config config/eval.json --run-id my-trace-v1
```

关键配置是：

```json
{
  "openclaw": {
    "trace_provider": {
      "base_url": "https://provider.example/v1",
      "api_format": "openai",
      "model": "provider/model-id"
    },
    "workers": 3,
    "trace_only": true
  }
}
```

已有 `full-v1` 时，不需要重新 collect 或 scenarios；直接以它作为固定输入，为不同候选模型池和 judge 创建新的 `experiment-id` 即可。完整命令、恢复方式、输出字段与打包说明见 [USER_MANUAL.md](USER_MANUAL.md)。

## 6. 数据使用边界

- 这是 call-level router 数据：分析 task-level 成功率时，应按 task/session 聚合，不能直接把 1,791 条调用分数简单平均。
- collect Trace 记录的是真实 agent policy 的轨迹，因此可能包含中间工具调用和失败尝试；不要仅保留“最终回答”调用。
- `full-v1` 的请求分布会受采集模型、OpenClaw 版本、任务 snapshot 与本地工具环境影响。新增或更换其中任一项时，应使用新的 `run-id`，不要混写进 `full-v1`。
- 发布核心资产请使用 `uv run scripts/package_release.py --run-id full-v1`；它会保留 collect/dataset、排除本地配置和所有实验输出。
