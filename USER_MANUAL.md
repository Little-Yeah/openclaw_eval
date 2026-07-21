# OpenClaw Eval 使用手册

本项目把一次 agent 任务拆成严格顺序的三阶段：**采集 Trace → 候选模型 inference → judge evaluate**。目标是得到供 router 训练使用的行级数据：

```text
scenario/request + candidate model
  → response / tool calls / token / latency / status
  → judge score / reason
```

同一个 `run-id` 对应一份不可变 Trace/请求数据集。可在其上运行任意多个 `experiment-id`（不同模型池、judge、并发或参数），互不覆盖，所有产物放在 `runs/<run-id>/`。

## 0. 先准备三组模型信息

三个阶段是独立的。请不要把 OpenClaw 的 agent 模型、候选模型和 judge 混为同一配置。

| 阶段 | 用户必须提供 | 配置位置 | 作用 |
| --- | --- | --- | --- |
| Trace collect | OpenClaw provider 的 **base URL、模型 ID、协议类型**；认证仍由用户自己的 OpenClaw 配置管理 | `config/eval.json` → `openclaw.trace_provider`；OpenClaw provider 本身见 `~/.openclaw/openclaw.json` | 运行 PinchBench agent，记录真实 request/response trace |
| Inference | 每个候选的 **name、base_url、model、api_format、api_key、concurrency** | `config/eval.json` → `inference.models` | 对每条 scenario 重放模型决策 |
| Evaluate | judge 的 **name、base_url、model、api_format、api_key、concurrency** | `config/eval.json` → `evaluate.judge` | 给 candidate response 打质量分 |

### 协议类型（`api_format`）

- `"openai"`：请求 `POST <base_url>/chat/completions`，认证头为 `Authorization: Bearer <api_key>`。
- `"anthropic"`：请求 `POST <base_url>/messages`，认证头为 `x-api-key: <api_key>` 和 `anthropic-version`。

`base_url` 必须是版本根路径，**不要**包含 `/chat/completions` 或 `/messages`。例如 OpenAI 兼容服务填 `https://provider.example/v1`。

### Trace provider 配置

`openclaw.trace_provider` 是 trace collect 的唯一 provider 描述：

```json
{
  "base_url": "https://provider.example/v1",
  "api_format": "openai",
  "model": "provider/model-id"
}
```

collector 自动启动 recorder，并依据 `base_url` 与 `api_format` 转发并记录请求；它不会要求本项目持有 provider key。认证由用户现有的 OpenClaw provider/auth 配置处理并透传。`model` 同时是 collect 阶段实际传给 PinchBench 的 OpenClaw 模型 ID。

为让请求经过 recorder，OpenClaw 中该 provider 的 `baseUrl` 应指向本机 `http://127.0.0.1:18080/<api_format>`：例如 `api_format: "openai"` 对应 `http://127.0.0.1:18080/openai`，`"anthropic"` 对应 `http://127.0.0.1:18080/anthropic`。上游真实地址只填在 `trace_provider.base_url`。OpenClaw provider 中的认证仍是用户自己的配置，不需要复制到本项目配置。

## 1. 建立本地配置

```bash
cp config/eval.example.json config/eval.json
```

`config/eval.json` 已被 gitignore，是放置真实 API key 的本地输入配置；不要把 key 写进 `README`、脚本或提交到 git。每个 experiment 会把本次配置冻结到 `runs/<run-id>/experiments/<experiment-id>/_state/config/`，因此 `runs/` 也必须保持 gitignored。

最小结构如下。真实值请自行替换：

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
  },
  "inference": {
    "models": [
      {
        "name": "candidate-a",
        "api_format": "openai",
        "base_url": "https://provider.example/v1",
        "api_key": "<CANDIDATE_KEY>",
        "model": "provider-model-id",
        "concurrency": 4,
        "max_tokens": 4096,
        "timeout": 180
      }
    ]
  },
  "evaluate": {
    "judge": {
      "name": "judge-a",
      "api_format": "openai",
      "base_url": "https://provider.example/v1",
      "api_key": "<JUDGE_KEY>",
      "model": "judge-model-id",
      "concurrency": 2,
      "max_tokens": 1024,
      "timeout": 180
    }
  }
}
```

`name` 用于输出目录，必须在候选池中唯一。`model` 是实际发送给 provider 的 model ID。候选和 judge 可以使用不同 provider、不同协议和不同 key。

### OpenClaw 最小配置

新安装 OpenClaw 时，复制 [config/openclaw.minimal.example.json](config/openclaw.minimal.example.json) 到 `~/.openclaw/openclaw.json`，并按其中 provider 字段填写自己的认证。已有 OpenClaw 配置时不要覆盖整份文件；只合并所需的 provider、默认模型和 gateway 字段。

collector 自动创建独立 benchmark agent/workspace，并设定最终 `skills: []`；它不复制用户 workspace 的 Skill。

## 2. 逐阶段运行

所有命令从仓库根目录执行。阶段必须按顺序运行：**collect 完成 → scenarios 完成 → inference 完成 → evaluate**。collect/scenarios 只按 `run-id` 运行；inference/evaluate 还必须指定 `experiment-id`。

### A. `collect`：运行 OpenClaw 并采集原始 Trace

```bash
uv run scripts/run_pipeline.py collect \
  --config config/eval.json \
  --run-id demo-v1
```

含义：启动本地 recorder；按 `openclaw.trace_provider.model` 运行 PinchBench；将每次底层模型调用落盘。默认使用 `openclaw.workers` 个独立 worker。`trace_only: true` 表示 PinchBench 自身不调用 judge，因此没有 benchmark 成败分数是预期行为。

常用参数：

| 参数 | 含义 |
| --- | --- |
| `--config PATH` | 本地模型配置，必填 |
| `--run-id ID` | 输出目录名，必填；推荐时间或语义版本，如 `20260719-v1` |
| `--resume` | 仅用于 `collect`；扫描已有 trace，只补未完成 task |

更底层控制可用：

```bash
uv run scripts/run_bench_pool.py \
  --model provider/model-id --run-id demo-v1 --workers 3 --trace-only \
  --config config/eval.json
```

它额外支持 `--suite task_sanity,task_xxx`（只跑指定 task）与 `--resume`。正常全量 PinchBench 目前有 147 个 task。

### B. `scenarios`：把 Trace 转为可重放输入

```bash
uv run scripts/run_pipeline.py scenarios \
  --config config/eval.json \
  --run-id demo-v1
```

这个阶段**不调用模型**。每一条 raw trace 一对一生成一条 scenario；不去重、不采样。它保存 system prompt、messages、tools/schema、task/category，以及原始 response 作为 judge 的参考。

仅做 smoke test 时可加 `--limit 4`。若已用该参数重建 `dataset/requests.jsonl`，后续阶段自然只会读取这 4 条；若保留完整请求集而只想抽样 inference，则也在 inference 中传相同 `--limit 4`。

底层等价命令：

```bash
uv run scripts/build_scenarios.py \
  --trace-dir runs/demo-v1/collect/traces \
  --output runs/demo-v1/dataset/requests.jsonl \
  --limit 4
```

### C. `inference`：每个候选模型重放 scenario

```bash
uv run scripts/run_pipeline.py inference \
  --config config/eval.json \
  --run-id demo-v1 \
  --experiment-id pool-a-v1
```

对 `inference.models` 的每个模型顺序处理。**同一个模型内部**按该模型的 `concurrency` 并发调用；所有 candidate inference 完成后，才应进入 evaluate。重跑时读取每个模型的 checkpoint，成功的 scenario (`status: "ok"`) 会跳过，失败项会重试。

底层等价命令：

```bash
uv run scripts/inference.py \
  --scenarios runs/demo-v1/dataset/requests.jsonl \
  --models runs/demo-v1/experiments/pool-a-v1/_state/config/candidate_models.json \
  --output-dir runs/demo-v1/experiments/pool-a-v1/inference \
  --state-dir runs/demo-v1/experiments/pool-a-v1/_state/inference \
  --limit 4
```

参数：`--scenarios` 为 scenario JSONL；`--models` 为 `{ "models": [...] }`；`--output-dir` 为结果根目录；`--limit` 是可选 smoke-test 条数。

### D. `evaluate`：用 judge 评分候选输出

```bash
uv run scripts/run_pipeline.py evaluate \
  --config config/eval.json \
  --run-id demo-v1 \
  --experiment-id pool-a-v1
```

judge 对每个 candidate prediction 的 request、参考 response、文本输出和 tool call 评分。**同一个候选模型内部**按 `evaluate.judge.concurrency` 并发评分。evaluate 必须等 inference 全部结束，因为它读取 `predictions.jsonl`。

底层等价命令：

```bash
uv run scripts/evaluate.py \
  --scenarios runs/demo-v1/dataset/requests.jsonl \
  --predictions-dir runs/demo-v1/experiments/pool-a-v1/inference \
  --judge runs/demo-v1/experiments/pool-a-v1/_state/config/judge.json \
  --output-dir runs/demo-v1/experiments/pool-a-v1/evaluate \
  --state-dir runs/demo-v1/experiments/pool-a-v1/_state/evaluate
```

## 3. 数据存储与如何阅读

```text
runs/<run-id>/
├── metadata/run.json                       # run 的状态和来源信息
├── collect/
│   ├── traces/<category>/<task>.jsonl      # 原始底层 API 调用
│   ├── results/worker-*/                  # PinchBench task 结果与 transcript
│   └── pool.json                           # worker 的退出码
├── dataset/requests.jsonl                  # 一行一条可重放请求样本
└── experiments/<experiment-id>/             # 一次独立的模型池 + judge 对照
    ├── metadata/run.json                    # 该 experiment 的阶段状态和命令
    ├── inference/<candidate-name>/
    │   ├── predictions.jsonl                # 对外候选输出
    │   └── summary.json                     # 成功/失败数量
    ├── evaluate/<candidate-name>/
    │   ├── results.jsonl                    # 对外 judge 评分
    │   └── summary.json                     # total/scored/mean_score/status_counts
    └── _state/
        ├── config/                          # 本次冻结配置（可能含 key；勿提交）
        ├── inference/<candidate-name>/checkpoint.jsonl
        └── evaluate/<candidate-name>/checkpoint.jsonl
```

关键 JSONL 字段：

| 文件 | 应重点读取的字段 | 含义 |
| --- | --- | --- |
| `collect/traces` | `_meta.status_code`, `request`, `response` | 真实 OpenClaw 底层调用及 HTTP 状态 |
| `dataset/requests` | `id`, `call_index`, `task_id`, `category`, `request.messages/tools/tool results`, `reference` | router/inference 的调用级输入与来源 |
| `predictions` | `id`, `model`, `prediction`, `tool_calls`, `token_in`, `token_out`, `latency_ms`, `status`, `error` | 一个候选模型的一次决策 |
| `evaluate/results` | `id`, `status`, `score`, `raw_score`, `reason`, `judge_model`, `latency_ms` | judge 的调用级 next-action 质量标签 |

状态解释：

- `predictions.status: "ok"`：候选模型返回有效响应。
- `predictions.status: "error"`：请求失败；检查 `error`，不是低质量分。
- `evaluate/results.status: "ok"`：有有效 `score`，范围 0–1；`raw_score` 为 0–10。
- `judge_unavailable`：judge 请求或 JSON 解析失败，`score: null`，**绝不能当成 0 分**。
- `inference_error`：候选没有成功输出，因此 judge 没有评分。

注意：一个 agent task 往往产生多条 trace。judge 评价的是当前状态下的下一步 action；合理的 read/exec 等信息收集调用可以高分，不要求单条 trace 完成整个 task。评估 task 成功率必须另行按 task/session rollout 聚合，不能直接平均所有 trace 分数。

## 4. 给执行 Agent 的固定工作流

当一个自动化 agent 使用本项目时，应按以下顺序行动：

1. 询问并确认三组配置：Trace OpenClaw provider（endpoint/model/protocol/auth）、candidate pool、judge。
2. 将密钥仅写入 gitignored 的 `config/eval.json`；验证它不在 `git diff` 中。
3. 先用小 `run-id` 验证 collect/dataset；再用语义化 `experiment-id` 和 `--limit 4` 验证 inference/evaluate。collect 的小样本用 `run_bench_pool.py --suite task_sanity`。
4. 检查 `predictions.jsonl` 中是否存在 `status: "error"`；先解决 endpoint/auth/协议错误，再扩大样本。
5. 检查 `evaluate/<model>/results.jsonl`：只将 `status: "ok"` 且非空 `score` 的行用于训练标签。
6. Trace 数据不变时复用相同 `run-id`，每个模型池/judge 组合使用新的 `experiment-id`；中断后使用相同两者重跑，利用 checkpoint/resume。

不要做的事：不要把 `judge_unavailable` 计为 0；不要在 scenario 生成阶段去重；不要让 inference 与 evaluate 对同一条未完成 prediction 并行；不要将真实 key 写入源码、文档或提交。

## 5. 打包可分发数据集

核心数据集是 `runs/full-v1/collect + runs/full-v1/dataset`。它可直接分发给其他用户；用户解压后只需复制 `config/eval.example.json` 为本地 `config/eval.json`，就能在该数据集上创建自己的 experiment，无需运行 collect。

```bash
# 先检查将要包含的内容；不会创建文件
uv run scripts/package_release.py --run-id full-v1 --dry-run

# 创建发布包，默认写入 dist/openclaw-eval-full-v1.zip
uv run scripts/package_release.py --run-id full-v1
```

打包脚本从不删除工作区文件，并固定排除：

- `config/` 中除 `*.example.*` 外的所有本地配置；
- 所有 `runs/<run-id>/experiments/`（候选输出、judge 输出、checkpoint、冻结 key）；
- 其他 run、`api_logs/` 本地调试记录、`.git`、缓存和已有 `dist/` 文件。

需要额外排除文件时可重复传入 `--exclude`，例如 `--exclude 'pinchbench-skill/**'`。发布前可用 `unzip -l dist/openclaw-eval-full-v1.zip` 检查 archive 内没有本地配置或 experiment。
