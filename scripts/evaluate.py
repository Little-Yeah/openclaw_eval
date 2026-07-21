#!/usr/bin/env python3
"""LLM-judge candidate predictions; unavailable judge is never converted to score 0."""
from __future__ import annotations
import argparse, json, time
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timezone
from pathlib import Path
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError

PROMPT = """You are a strict judge of ONE next decision in an agent trajectory. Score the candidate's next response/action from 0 to 10.

The CURRENT TRAJECTORY STATE is not a request to finish the entire original PinchBench task in one turn. The candidate has no tool-execution environment: it can only emit text and/or tool calls. Do NOT penalize a candidate merely because it has not yet created the final file, completed the full task, or produced findings that require an unavailable tool result.

Give a high score to an appropriate next action, including an information-gathering tool call when that is the necessary next step. Penalize an incorrect or irrelevant action, malformed tool arguments, unsupported conclusions, or claims that an unperformed side effect has happened. Only expect a final answer or final write action when the current state already provides enough information.

The reference next action is trajectory context, not wording to copy. Judge independently against the current state. Keep the reason focused on next-action quality, not whole-task completion. Return JSON only: {{\"score\": <0-10>, \"reason\": \"...\"}}.

CURRENT TRAJECTORY STATE:
{request}

REFERENCE NEXT ACTION:
{reference}

CANDIDATE TEXT:
{candidate}

CANDIDATE TOOL CALLS:
{tools}"""
def recs(path):
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.strip(): yield json.loads(line)
def now(): return datetime.now(timezone.utc).isoformat()
def judge(cfg, scenario, prediction):
    if prediction.get("status") != "ok": return {"id":scenario["id"],"status":"inference_error","score":None,"error":prediction.get("error","")}
    reference = scenario.get("reference", {})
    prompt=PROMPT.format(request=json.dumps(scenario["request"],ensure_ascii=False), reference=json.dumps({"text": reference.get("response_text", ""), "tool_calls": reference.get("tool_calls", [])}, ensure_ascii=False), candidate=prediction.get("prediction",""), tools=json.dumps(prediction.get("tool_calls",[]),ensure_ascii=False))
    key=cfg.get("api_key", ""); started=time.monotonic(); api_format=cfg.get("api_format", "openai")
    try:
        payload={"model":cfg.get("model",cfg["name"]),"messages":[{"role":"user","content":prompt}],"temperature":0,"max_tokens":cfg.get("max_tokens",1024)}
        headers={"Content-Type":"application/json","Authorization":f"Bearer {key}","User-Agent":"openclaw-eval/0.1"}; endpoint="/chat/completions"
        if api_format == "anthropic": headers={"Content-Type":"application/json","x-api-key":key,"anthropic-version":"2023-06-01","User-Agent":"openclaw-eval/0.1"}; endpoint="/messages"
        request=Request(cfg["base_url"].rstrip("/")+endpoint,data=json.dumps(payload).encode(),headers=headers,method="POST")
        with urlopen(request,timeout=float(cfg.get("timeout",120))) as r: data=json.loads(r.read())
        raw=("\n".join(x.get("text","") for x in data.get("content",[]) if x.get("type")=="text") if api_format == "anthropic" else data["choices"][0]["message"].get("content", "")); parsed=json.loads(raw[raw.find("{"):raw.rfind("}")+1]); score=float(parsed["score"])/10
        return {"id":scenario["id"],"status":"ok","score":max(0,min(1,score)),"raw_score":parsed["score"],"reason":parsed.get("reason",""),"judge_model":cfg["name"],"latency_ms":round((time.monotonic()-started)*1000),"completed_at":now()}
    except (HTTPError,URLError,TimeoutError,KeyError,ValueError,json.JSONDecodeError) as exc:
        if isinstance(exc, HTTPError):
            try: detail = exc.read().decode("utf-8", errors="replace")[:2000]
            except OSError: detail = ""
            error = f"HTTP {exc.code}: {detail or exc.reason}"
        else: error = str(exc)
        return {"id":scenario["id"],"status":"judge_unavailable","score":None,"error":error,"judge_model":cfg["name"],"completed_at":now()}
def main():
    p=argparse.ArgumentParser(); p.add_argument("--scenarios",type=Path,required=True); p.add_argument("--predictions-dir",type=Path,required=True); p.add_argument("--judge",type=Path,required=True); p.add_argument("--output-dir",type=Path,required=True); p.add_argument("--state-dir",type=Path); args=p.parse_args()
    scenarios={s["id"]:s for s in recs(args.scenarios)}; cfg=json.loads(args.judge.read_text()); args.output_dir.mkdir(parents=True,exist_ok=True)
    for file in args.predictions_dir.glob("*/predictions.jsonl"):
        outdir=args.output_dir/file.parent.name; outdir.mkdir(parents=True,exist_ok=True); state=(args.state_dir or args.output_dir)/file.parent.name; state.mkdir(parents=True,exist_ok=True); checkpoint=state/"checkpoint.jsonl"; prior={r["id"]:r for r in recs(checkpoint)} if checkpoint.exists() else {}; preds=list(recs(file)); pending=[x for x in preds if x["id"] not in prior]
        with checkpoint.open("a",encoding="utf-8") as out, ThreadPoolExecutor(max_workers=int(cfg.get("concurrency",1))) as pool:
            futures=[pool.submit(judge,cfg,scenarios[x["id"]],x) for x in pending]
            for f in as_completed(futures): out.write(json.dumps(f.result(),ensure_ascii=False)+"\n"); out.flush()
        final={r["id"]:r for r in recs(checkpoint)}; rows=[final[x["id"]] for x in preds]; (outdir/"results.jsonl").write_text("".join(json.dumps(x,ensure_ascii=False)+"\n" for x in rows),encoding="utf-8")
        scored=[x["score"] for x in rows if x.get("score") is not None]; (outdir/"summary.json").write_text(json.dumps({"total":len(rows),"scored":len(scored),"mean_score":sum(scored)/len(scored) if scored else None,"status_counts":{s:sum(x.get("status")==s for x in rows) for s in set(x.get("status") for x in rows)}},indent=2),encoding="utf-8")
    return 0
if __name__=="__main__": raise SystemExit(main())
