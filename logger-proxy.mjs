import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import path from 'node:path';

// ── Configuration ────────────────────────────────────────────────────────────
const LOG_DIR = process.env.PINCHBENCH_API_LOG_DIR
  || '/Users/garrick/workspace/openclaw_eval/api_logs';
const PORT = 18080;
let proxyConfig = {};
if (process.env.PINCHBENCH_CONFIG) {
  try { proxyConfig = JSON.parse(fs.readFileSync(process.env.PINCHBENCH_CONFIG, 'utf8')); }
  catch (err) { console.error(`[Proxy] Could not load PINCHBENCH_CONFIG: ${err.message}`); }
}
const traceProvider = proxyConfig?.openclaw?.trace_provider;

function providerRoute(reqUrl) {
  if (!traceProvider?.base_url) return null;
  let upstream;
  try { upstream = new URL(traceProvider.base_url); }
  catch { throw new Error(`Invalid openclaw.trace_provider.base_url: ${traceProvider.base_url}`); }
  const apiFormat = traceProvider.api_format || 'anthropic';
  const localPrefix = `/${apiFormat}`;
  if (!reqUrl.startsWith(localPrefix)) return null;
  const suffix = reqUrl.slice(localPrefix.length) || '/';
  const basePath = upstream.pathname.replace(/\/$/, '');
  return { host: upstream.hostname, port: upstream.port || (upstream.protocol === 'http:' ? 80 : 443), protocol: upstream.protocol, path: `${basePath}${suffix}` };
}

// ── Task context (set via control endpoint) ──────────────────────────────────
let currentTask = {
  task_id: 'unknown',
  category: 'uncategorized',
  call_index: 0,
};

function getLogPath(task = currentTask) {
  const dir = path.join(LOG_DIR, task.category);
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `${task.task_id}.jsonl`);
}

const taskCallIndexes = new Map();
function taskForRequest(rawRequest) {
  const match = JSON.stringify(rawRequest).match(/PINCHBENCH_TRACE task_id=([^\s\]]+) category=([^\s\]]+)/);
  if (!match) return currentTask;
  const key = `${match[2]}/${match[1]}`;
  const call_index = taskCallIndexes.get(key) || 0;
  taskCallIndexes.set(key, call_index + 1);
  return { task_id: match[1], category: match[2], call_index };
}

// ── Reconstruct a full Anthropic-style message response from SSE stream ──────
// This produces an object equivalent to what the non-streaming API would return.
function reconstructResponseFromSSE(buffer) {
  let msgId = null;
  let msgModel = null;
  let stopReason = null;
  let usage = null;

  // Content blocks: each is built up incrementally from events
  const contentBlocks = [];
  let currentBlock = null;

  for (const line of buffer.split('\n')) {
    if (!line.startsWith('data: ')) continue;
    const dataStr = line.substring(6).trim();
    if (dataStr === '[DONE]') continue;

    let ev;
    try { ev = JSON.parse(dataStr); } catch { continue; }

    switch (ev.type) {
      case 'message_start':
        if (ev.message) {
          msgId    = ev.message.id    || null;
          msgModel = ev.message.model || null;
          usage    = ev.message.usage || null;
        }
        break;

      case 'content_block_start':
        currentBlock = { ...ev.content_block };
        // Prepare mutable text accumulator fields
        if (currentBlock.type === 'thinking') currentBlock.thinking = '';
        if (currentBlock.type === 'text')     currentBlock.text = '';
        if (currentBlock.type === 'tool_use') currentBlock._input_json = '';
        break;

      case 'content_block_delta':
        if (!currentBlock || !ev.delta) break;
        if (ev.delta.type === 'thinking_delta')   currentBlock.thinking   += (ev.delta.thinking   || '');
        if (ev.delta.type === 'text_delta')        currentBlock.text       += (ev.delta.text       || '');
        if (ev.delta.type === 'input_json_delta')  currentBlock._input_json += (ev.delta.partial_json || '');
        break;

      case 'content_block_stop':
        if (!currentBlock) break;
        // Finalise tool_use input: parse accumulated JSON string
        if (currentBlock.type === 'tool_use') {
          try { currentBlock.input = JSON.parse(currentBlock._input_json); }
          catch { currentBlock.input = currentBlock._input_json; }
          delete currentBlock._input_json;
        }
        contentBlocks.push(currentBlock);
        currentBlock = null;
        break;

      case 'message_delta':
        if (ev.delta?.stop_reason) stopReason = ev.delta.stop_reason;
        if (ev.usage)              usage = { ...(usage || {}), ...ev.usage };
        break;

      case 'message_stop':
        break;
    }
  }

  // Build the reconstructed response in Anthropic message format
  return {
    id:          msgId,
    type:        'message',
    role:        'assistant',
    content:     contentBlocks,
    model:       msgModel,
    stop_reason: stopReason,
    usage:       usage,
  };
}

// ── Server ───────────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  const reqUrl = req.url;

  // ── Control endpoint: POST /__proxy_control/set_task ──────────────────────
  if (req.method === 'POST' && reqUrl === '/__proxy_control/set_task') {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      try {
        const { task_id, category } = JSON.parse(body);
        currentTask = {
          task_id:     task_id   || 'unknown',
          category:    category  || 'uncategorized',
          call_index:  0,
        };
        console.log(`[Proxy] Task context → ${currentTask.category}/${currentTask.task_id}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch {
        res.writeHead(400);
        res.end('Bad JSON');
      }
    });
    return;
  }

  // ── Proxy routing ─────────────────────────────────────────────────────────
  let route;
  try { route = providerRoute(reqUrl); }
  catch (err) {
    res.statusCode = 500;
    res.end(err.message);
    return;
  }
  if (!route) {
    console.log(`[Proxy] No route matched: ${req.method} ${reqUrl}`);
    res.statusCode = 404;
    res.end('No Route Matched');
    return;
  }

  const targetHost = route.host;
  const targetPath = route.path;
  console.log(`[Proxy] Intercepted: ${req.method} ${reqUrl} → https://${targetHost}${targetPath}`);

  let bodyChunks = [];
  req.on('data', chunk => bodyChunks.push(chunk));
  req.on('end', () => {
    const reqBodyBuf = Buffer.concat(bodyChunks);

    // Parse the raw request body — store as-is
    let rawRequest;
    try { rawRequest = JSON.parse(reqBodyBuf.toString('utf-8')); }
    catch { rawRequest = { _raw: reqBodyBuf.toString('utf-8') }; }

    // Prefer the request-local task marker. This keeps trace routing correct
    // when multiple benchmark workers run concurrently.
    const taskContext = taskForRequest(rawRequest);
    const callIndex = taskContext.call_index;

    const headers = { ...req.headers, host: targetHost };
    // Default: preserve the authorization OpenClaw already supplied. An
    // optional config auth object exists for providers that require the proxy
    // to own credentials; it is never required for normal user-managed auth.
    const auth = traceProvider?.auth;
    if (auth?.api_key) {
      const header = (auth.header || (traceProvider.api_format === 'anthropic' ? 'x-api-key' : 'authorization')).toLowerCase();
      headers[header] = auth.scheme ? `${auth.scheme} ${auth.api_key}` : auth.api_key;
    }

    const transport = route.protocol === 'http:' ? http : https;
    const proxyReq = transport.request(
      { hostname: targetHost, port: route.port, path: targetPath, method: req.method, headers },
      (proxyRes) => {
        res.writeHead(proxyRes.statusCode, proxyRes.headers);

        const isSSE = String(proxyRes.headers['content-type']).includes('text/event-stream');
        let responseBuffer = '';

        proxyRes.on('data', chunk => {
          responseBuffer += chunk.toString('utf-8');
          res.write(chunk);
        });

        proxyRes.on('end', () => {
          // Reconstruct raw response
          let rawResponse;
          if (isSSE) {
            // Rebuild the equivalent non-streaming Anthropic message object
            rawResponse = reconstructResponseFromSSE(responseBuffer);
          } else {
            try { rawResponse = JSON.parse(responseBuffer); }
            catch { rawResponse = { _raw: responseBuffer }; }
          }

          // ── JSONL record: minimal envelope + raw request & response ────────
          const record = {
            // Envelope metadata (for indexing/filtering only)
            _meta: {
              id:          `${taskContext.task_id}_call_${callIndex}`,
              task_id:     taskContext.task_id,
              category:    taskContext.category,
              call_index:  callIndex,
              timestamp:   new Date().toISOString(),
              status_code: proxyRes.statusCode,
            },
            // Raw API request body (exactly what OpenClaw sent)
            request: rawRequest,
            // Reconstructed API response (equivalent to non-streaming response)
            response: rawResponse,
          };

          try {
            fs.appendFileSync(getLogPath(taskContext), JSON.stringify(record) + '\n');
          } catch (err) {
            console.error('[Proxy] Failed to write log:', err.message);
          }

          res.end();
        });
      }
    );

    proxyReq.on('error', (err) => {
      console.error(`[Proxy] Upstream Error: ${err.message}`);
      const errRecord = {
        _meta: {
          id:         `${taskContext.task_id}_call_${callIndex}`,
          task_id:    taskContext.task_id,
          category:   taskContext.category,
          call_index: callIndex,
          timestamp:  new Date().toISOString(),
          status_code: 502,
          error:      err.message,
        },
        request:  rawRequest,
        response: null,
      };
      try { fs.appendFileSync(getLogPath(taskContext), JSON.stringify(errRecord) + '\n'); } catch {}
      res.statusCode = 502;
      res.end('Proxy Upstream Error');
    });

    proxyReq.write(reqBodyBuf);
    proxyReq.end();
  });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[Proxy] Listening on http://127.0.0.1:${PORT}`);
  console.log(`[Proxy] Logs  → ${LOG_DIR}/{category}/{task_id}.jsonl`);
  console.log(`[Proxy] Ctrl  → POST /__proxy_control/set_task  {"task_id":"...","category":"..."}`);
});
