# Router Lab / OpenClaw Eval 使用手册

本仓库有两条独立的使用路径：

1. **Router Lab Demo（本手册第一部分）**：用已训练的本地 Router 为 PinchBench Agent 的每一个模型步骤选择标签，实际调用你配置的模型 provider，并在网页中实时查看路由、工具调用、结果和评分。
2. **OpenClaw Eval 离线流水线（第二部分）**：采集 trace、重放候选模型并由 judge 评分，用于后续训练 Router。

以下所有命令默认在仓库根目录执行。

---

## A. Router Lab Demo

### A.1 它会做什么

```text
浏览器选择 PinchBench case
  → FastAPI 创建独立 run/workspace
  → LangGraph Agent 的每个模型步骤调用本地 Router
  → Router 输出预测标签、概率、质量/成本估计
  → 本地配置中的 provider 实际生成回复
  → SSE 将路由、模型、工具和完成事件推到网页
```

Router 的**预测标签**和实际执行模型有意分开：多个 Router label 可以映射到同一个 execution profile。页面会同时显示 Router 选择的 label 和实际执行 provider/model。这让没有七个真实模型账户时仍能演示路由决策。

### A.2 前置条件

| 项目 | 建议版本 / 用途 |
| --- | --- |
| macOS 或 Linux | 本 demo 在 macOS 上的启动脚本会自动打开浏览器 |
| Python | 3.11+；由 `uv` 管理虚拟环境 |
| [uv](https://docs.astral.sh/uv/) | Python 包、环境和命令管理 |
| Node.js + npm | Node.js 20+，用于 React/Vite 前端 |
| 模型 provider 的 API Key | 用于真实模型调用和可选 LLM judge，会产生对应账号的 API 用量 |

先确认工具可用：

```bash
uv --version
node --version
npm --version
```

### A.3 准备 Router 模型资产（首次一次）

Router 的权重不提交到 Git。将本地 `resource/` 中的参考资产复制到 Router 自己的运行目录；运行时不会 import 或依赖 `resource/`：

```bash
mkdir -p apps/router/var/assets

cp -R resource/chinese_mobilebert_base_f2 \
  apps/router/var/assets/chinese_mobilebert_base_f2

cp resource/router_finetune/artifacts/v131_red_pools_clean_20260708_141739/pool_866_865_294_305_10000_10002_10003/seed_44/best_router_finetuned.pth \
  apps/router/var/assets/best_router_finetuned.pth

cp resource/router_finetune/artifacts/v131_red_pools_clean_20260708_141739/pool_866_865_294_305_10000_10002_10003/seed_44/runtime_model_representations.npz \
  apps/router/var/assets/runtime_model_representations.npz
```

完成后应有：

```text
apps/router/var/assets/
├── chinese_mobilebert_base_f2/
├── best_router_finetuned.pth
└── runtime_model_representations.npz
```

若这三个项目已存在，无需重复复制。`apps/router/var/` 被 Git 忽略。

### A.4 配置模型 provider 与可选 judge（必须）

复制模板，再仅在本机填写 key：

```bash
cp apps/router/config/models.example.json apps/router/config/models.json
```

在 `apps/router/config/models.json` 中找到：

```json
"execution_profiles": {
  "default_provider": {
    "api_type": "openai",
    "base_url": "https://provider.example/v1",
    "api_key": "PASTE_YOUR_PROVIDER_API_KEY_HERE",
    "model_name": "your-model-id"
  }
}
```

把占位的 `base_url`、`api_key` 和 `model_name` 改成你的 provider 配置。`api_type` 支持 `openai`（`POST <base_url>/chat/completions`）和 `anthropic`（`POST <base_url>/messages`）；`base_url` 不应包含这两个路径后缀。demo 不读取环境变量；所有 label 到 provider、model 和 key 的映射都在这个本地 config 中。`models.json` 已被 Git 忽略，模板文件可以安全提交。不要把 key 粘贴到 issue、聊天记录或代码中。

`judge` 是可选的后处理裁判配置。每个 run 完成后，PinchBench 会先保存 trace，再按 task 的 grading type 运行自动评分、LLM judge 或混合评分。judge 可直接填写自己的 `api_key` / `model`，或通过 `execution_profile` 复用上面的本地凭据和模型：

```json
"judge": {
  "name": "default-judge",
  "api_type": "openai",
  "base_url": "https://provider.example/v1",
  "execution_profile": "default_provider"
}
```

没有 `judge` 时，自动评分 task 仍可得到分数；`llm_judge` / `hybrid` task 会在结果中标记 judge 不可用。无需也不应配置 OpenRouter。

可按需调整：

| 字段 | 作用 |
| --- | --- |
| `default_candidates` | 默认参与排序的 Router label；可删减为任意 checkpoint 已知标签的子集 |
| `models[].execution_profile` | 每个预测 label 要使用的实际执行 profile；可让所有 label 复用一个 profile，也可分别映射 |
| `execution_profiles.<name>.api_type` | provider 协议：`openai` 或 `anthropic` |
| `execution_profiles.<name>.base_url` | provider 的版本根路径；程序按协议补齐请求路径 |

### A.5 安装依赖（首次一次）

最快路径只需同步 API 项目；它会通过 editable local package 引入 Agent 和 Router。前端由启动脚本自动安装，也可提前安装：

```bash
cd apps/api && uv sync && cd ../..
cd apps/web && npm install && cd ../..
```

Router 是 CPU 推理，仍需要 PyTorch、Transformers 和权重，因此第一次 `uv sync` 可能较慢；demo 不要求 GPU。

### A.6 一条命令启动

```bash
make demo
```

它会启动：

| 服务 | 地址 | 作用 |
| --- | --- | --- |
| FastAPI | `http://127.0.0.1:8000` | case、run、history 与 SSE API |
| Vite/React | `http://127.0.0.1:5173` | Router Lab 网页 |

脚本会等待两个服务健康后自动打开浏览器。若浏览器没有自动打开，手动访问 `http://127.0.0.1:5173`。保持该终端运行；按 `Ctrl+C` 会同时停止前后端。

开发时，API 会监控 `apps/api/src`、`apps/agent/src`、`apps/router/src` 并热重载，Vite 会热更新网页。若修改了依赖或 config，建议停止后重新执行 `make demo`。

### A.7 网页操作与可观察内容

1. 在左侧点击 **New test**。
2. 搜索或选择一个 PinchBench case；页面会显示 task prompt、类别、评分类型和 timeout。
3. 选择 Routing policy：从 Quality first 到 Lowest cost。它影响 Router 对质量和成本预测的权衡，不改变实际执行 profile。
4. 点击 **Start agent run**。
5. 在 run 页面依次查看每个 step：
   - Router 选择的 label、最高概率；展开 **Router scorecard** 可看候选概率、预测质量和预估成本；
   - `Model provider is working…` 表示路由完成、正在等待真实模型 API 返回，不是页面卡死；
   - `Agent reasoning`、最终 content 会按 Markdown 渲染；
   - 若该步需要工具，左列是 tool call（名称和参数），右列是对应 tool result；
   - 结束时的 Summary 汇总模型步数、Router 预估成本、涉及的预测标签和工具；随后会出现 PinchBench Evaluation，显示 Score、维度明细和 judge notes。比较多个 run 时，这些评分会集中显示在独立的 Score Comparison 区域。
6. 左侧 Run history 可重新打开历史 run；已结束 run 悬停后点击 `×` 并确认可删除。删除会移除该 run 的 event log 与隔离 workspace，不能恢复；运行中的 run 不可删除。

### A.8 API 与 SSE 冒烟测试

网页之外也可直接验证后端。先另开终端并保持 `make demo` 正在运行：

```bash
# 服务健康与 147 个 case
curl http://127.0.0.1:8000/api/health
curl http://127.0.0.1:8000/api/cases

# 创建一个最小真实 run（会调用配置好的 provider）
curl -X POST http://127.0.0.1:8000/api/runs \
  -H 'content-type: application/json' \
  --data '{"case_id":"task_sanity","preference":2,"max_steps":2}'
```

从 POST 返回值复制 `run_id`，然后观察事件流：

```bash
curl -N http://127.0.0.1:8000/api/runs/<run_id>/events
```

正常顺序为：`run_started` → `router_decision` → `model_call_started` → `model_response` →（可选的 `tool_result` 与下一轮）→ `run_completed`。历史事件与 run summary 分别可通过：

```bash
curl http://127.0.0.1:8000/api/runs
curl http://127.0.0.1:8000/api/runs/<run_id>
curl http://127.0.0.1:8000/api/runs/<run_id>/events/history
```

若要删除一个已完成 run：

```bash
curl -X DELETE http://127.0.0.1:8000/api/runs/<run_id>
```

### A.9 单独测试 Router 或 Agent

适合排查网页以外的问题：

```bash
# 只看 Router 的压缩上下文，不加载模型
cd apps/router
uv run pinch-router context --trace examples/trace.json

# 本地 Router 预测；不会调用 provider
uv run pinch-router route --trace examples/trace.json

# Router 预测并真实调用 provider
uv run pinch-router execute --trace examples/trace.json

# 运行一个完整 LangGraph Agent case
cd ../agent
uv run pinch-agent run --case task_sanity
```

### A.10 常见问题

| 现象 | 检查与处理 |
| --- | --- |
| `models.json` 不存在 / API key 报错 | 执行 A.4 的复制命令，确认填写的是所选 `execution_profile` 的 `api_key` |
| 缺少 `.pth`、`.npz` 或 `chinese_mobilebert_base_f2` | 按 A.3 复制三项资产，确认路径在 `apps/router/var/assets/` |
| LLM judge 返回 404 | 确认 `judge.base_url` 是版本根路径，而非已带 `/messages` 或 `/chat/completions` 的完整路径；确认 `api_type` 与 provider 协议一致 |
| 页面显示正在等待模型 | 该步骤已开始真实 HTTP 调用；检查启动终端中的 API 日志、key、网络和 provider 配置。等待结束后会显示完成或失败状态 |
| `Address already in use` | 已有 `make demo` / API / Vite 进程占用了 8000 或 5173；停止旧进程后重试 |
| 打开 `:5173` 但没有 case | 确认 `curl http://127.0.0.1:8000/api/health` 返回 `{"status":"ok"}` |
| Web 依赖安装失败 | 确认 Node.js 20+；删除 `apps/web/node_modules` 后重新执行 `npm install` |
| LangGraph 的 `LangChainPendingDeprecationWarning` | 当前依赖的非阻断警告，不影响运行；API 出现 `Application startup complete` 表示已就绪 |

### A.11 本地数据与安全

| 路径 | 内容 | Git 状态 |
| --- | --- | --- |
| `apps/router/config/models.json` | provider/judge key、endpoint、执行 profile | 忽略 |
| `apps/router/var/assets/` | Router checkpoint 和 encoder 权重 | 忽略 |
| `apps/api/var/runs/` | 每次 run 的元数据、SSE event log、Agent workspace | 忽略 |
| `apps/agent/var/` | 单独运行 Agent 时的 workspace | 忽略 |
| `apps/web/node_modules/`、`apps/web/dist/` | 前端本地依赖与构建产物 | 忽略 |

---

## B. OpenClaw Eval 离线流水线

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
