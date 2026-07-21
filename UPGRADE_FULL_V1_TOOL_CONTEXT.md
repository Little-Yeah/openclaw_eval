# full-v1 tool-context 修复包

此修复包面向已收到旧版 `openclaw-eval-full-v1.zip` 并已配置好 `config/eval.json` 的用户。

## 修复内容

旧版 scenario 转换错误地将历史 assistant tool call 和 user tool result 压成空文本。候选模型仍能看到当前可用 tools 并预测 tool call，但后续调用缺少此前工具执行的上下文，因此不适合用于调用级 tool-call router 训练。

修复后的 dataset 保留：

- 历史 assistant tool calls；
- 对应的 user tool results；
- `call_index`；
- reference step 的 tool calls。

judge 也改为评估当前一步 action 是否合理，不再要求每条调用独立完成整个 PinchBench task。

## 升级步骤

在原有项目目录直接解压此修复包并覆盖同名文件：

```bash
unzip -o openclaw-eval-full-v1-tool-context-fix.zip
```

该包不含 `config/`，不会覆盖已有的 `config/eval.json`，也不要求重新配置 endpoint、模型或 API key。

不需要重新 collect，也不需要重新运行 OpenClaw/PinchBench。必须重新运行 inference 和 evaluate，因为旧 prediction 的输入上下文不完整、旧 judge score 的评分标准也不同。请使用新的 experiment ID 保留旧结果作为历史记录：

```bash
uv run scripts/run_pipeline.py inference \
  --config config/eval.json \
  --run-id full-v1 \
  --experiment-id tool-context-v2

uv run scripts/run_pipeline.py evaluate \
  --config config/eval.json \
  --run-id full-v1 \
  --experiment-id tool-context-v2
```

旧 experiment 的结果不能和 `tool-context-v2` 的分数直接比较。
