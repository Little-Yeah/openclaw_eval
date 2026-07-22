import { useEffect, useMemo, useState } from 'react'
import { createRoot } from 'react-dom/client'
import Markdown from 'react-markdown'
import './styles.css'

type Case = { id: string; name: string; category: string; grading_type: string; timeout_seconds: number }
type Candidate = { label: string; probability: number; predicted_quality: number; predicted_cost: number }
type Run = { run_id: string; case_id: string; status: 'queued' | 'running' | 'completed' | 'failed'; created_at: string; final_answer?: string; error?: string; summary?: Summary }
type Summary = { steps: number; router_estimated_cost: number; routed_models: string[]; tools: string[] }
type ParsedAction = { type?: string; name?: string; arguments?: Record<string, unknown>; answer?: string }
type AgentEvent = { event: string; sequence?: number; step?: number; routed_label?: string; candidates?: Candidate[]; executed_model?: string; router_latency_ms?: number; model_latency_ms?: number; content?: string; reasoning?: string; action?: ParsedAction; tool?: string; result?: string; final_answer?: string; error?: string }
type Step = { index: number; route?: AgentEvent; calling?: AgentEvent; response?: AgentEvent; tool?: AgentEvent }

const api = import.meta.env.VITE_API_URL || ''
const money = (value?: number) => `$${(value || 0).toExponential(1)}`
const preferenceCopy = ['Quality first', 'Quality-led balance', 'Balanced', 'Cost-aware', 'Cost-led balance', 'Lowest cost']

function parseActionPayload(value?: string): ParsedAction | null {
  if (!value) return null
  try {
    const parsed = JSON.parse(value) as ParsedAction
    return parsed && typeof parsed === 'object' ? parsed : null
  } catch {
    return null
  }
}

function formatToolAction(action: ParsedAction) {
  const path = typeof action.arguments?.path === 'string' ? action.arguments.path : null
  if (action.type === 'tool') {
    if (action.name === 'write_file' && path) return `Wrote ${path}`
    if (action.name === 'read_file' && path) return `Read ${path}`
    if (action.name === 'list_files') return 'Listed workspace files'
    return `Ran ${action.name || 'tool'}`
  }
  return action.answer || 'Completed'
}

function prettyJson(value: unknown) {
  return JSON.stringify(value, null, 2)
}

function toSteps(events: AgentEvent[]) {
  const byStep = new Map<number, Step>()
  let latestResponse: Step | undefined
  for (const event of events) {
    if (event.step === undefined) continue
    const current = byStep.get(event.step) || { index: event.step }
    if (event.event === 'router_decision') current.route = event
    if (event.event === 'model_call_started') current.calling = event
    if (event.event === 'model_response') {
      current.response = event
      latestResponse = current
    }
    if (event.event === 'tool_result' && latestResponse && !latestResponse.tool) {
      latestResponse.tool = event
      continue
    }
    if (event.event === 'tool_result') current.tool = event
    byStep.set(event.step, current)
  }
  return [...byStep.values()].sort((a, b) => a.index - b.index)
}

function App() {
  const [cases, setCases] = useState<Case[]>([])
  const [runs, setRuns] = useState<Run[]>([])
  const [selected, setSelected] = useState<Case | null>(null)
  const [casePrompt, setCasePrompt] = useState('')
  const [query, setQuery] = useState('')
  const [preference, setPreference] = useState(2)
  const [events, setEvents] = useState<AgentEvent[]>([])
  const [activeRun, setActiveRun] = useState<Run | null>(null)
  const [screen, setScreen] = useState<'new' | 'run'>('new')
  const steps = useMemo(() => toSteps(events), [events])
  const filtered = useMemo(() => cases.filter(item => `${item.name} ${item.category}`.toLowerCase().includes(query.toLowerCase())), [cases, query])

  useEffect(() => {
    Promise.all([fetch(`${api}/api/cases`).then(r => r.json()), fetch(`${api}/api/runs`).then(r => r.json())]).then(([caseData, runData]) => {
      setCases(caseData.items)
      setRuns(runData.items)
      chooseCase(caseData.items.find((item: Case) => item.id === 'task_files') || caseData.items[0])
    })
  }, [])

  function chooseCase(item: Case) {
    setSelected(item)
    fetch(`${api}/api/cases/${item.id}`).then(r => r.json()).then(data => setCasePrompt(data.prompt || ''))
  }

  async function start() {
    if (!selected) return
    setEvents([])
    const response = await fetch(`${api}/api/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ case_id: selected.id, preference, max_steps: 8 }),
    })
    const payload = await response.json()
    if (!response.ok) {
      setEvents([{ event: 'run_failed', error: payload.detail || 'Could not create run' }])
      return
    }
    const run: Run = { run_id: payload.run_id, case_id: selected.id, status: 'running', created_at: new Date().toISOString() }
    setActiveRun(run)
    setRuns(previous => [run, ...previous])
    setScreen('run')
    const source = new EventSource(`${api}${payload.events_url}`)
    ;['run_started', 'router_decision', 'model_call_started', 'model_response', 'tool_result', 'run_completed', 'run_failed'].forEach(name => source.addEventListener(name, message => {
      const event = JSON.parse((message as MessageEvent).data) as AgentEvent
      setEvents(previous => [...previous, event])
      if (name === 'run_completed' || name === 'run_failed') {
        source.close()
        fetch(`${api}/api/runs/${payload.run_id}`).then(r => r.json()).then(record => {
          setActiveRun(record)
          setRuns(previous => [record, ...previous.filter(item => item.run_id !== record.run_id)])
        })
      }
    }))
    source.onerror = () => source.close()
  }

  async function openRun(run: Run) {
    const [record, history] = await Promise.all([
      fetch(`${api}/api/runs/${run.run_id}`).then(r => r.json()),
      fetch(`${api}/api/runs/${run.run_id}/events/history`).then(r => r.json()),
    ])
    setActiveRun(record)
    setEvents(history.items)
    setSelected(cases.find(item => item.id === record.case_id) || null)
    setScreen('run')
  }

  async function deleteRun(run: Run) {
    if (!window.confirm(`Delete the saved run “${cases.find(item => item.id === run.case_id)?.name || run.case_id}”?`)) return
    const response = await fetch(`${api}/api/runs/${run.run_id}`, { method: 'DELETE' })
    if (!response.ok) {
      window.alert((await response.json()).detail || 'Could not delete this run.')
      return
    }
    setRuns(previous => previous.filter(item => item.run_id !== run.run_id))
    if (activeRun?.run_id === run.run_id) newTest()
  }

  function newTest() {
    setScreen('new')
    setActiveRun(null)
    setEvents([])
  }

  const summary = activeRun?.summary

  return <main className="app-shell">
    <aside className="sidebar">
      <div className="brand"><span>PINCHBENCH × ROUTING</span><h1>Router<i>Lab</i></h1></div>
      <button className="new-test" onClick={newTest}>＋ New test</button>
      <div className="history-label">RUN HISTORY <b>{runs.length}</b></div>
      <div className="history">
        {runs.length === 0 && <p className="history-empty">Your completed tests will live here.</p>}
        {runs.map(run => <div key={run.run_id} className="history-row">
          <button className={`history-item ${activeRun?.run_id === run.run_id ? 'active' : ''}`} onClick={() => openRun(run)}>
            <span className={`dot ${run.status}`}/>
            <div>
              <strong>{cases.find(item => item.id === run.case_id)?.name || run.case_id}</strong>
              <small>{run.status} · {new Date(run.created_at).toLocaleString()}</small>
            </div>
          </button>
          {run.status !== 'running' && run.status !== 'queued' && <button className="delete-run" title="Delete saved run" aria-label={`Delete ${run.case_id}`} onClick={() => deleteRun(run)}>×</button>}
        </div>)}
      </div>
    </aside>
    <section className="conversation">
      {screen === 'new'
        ? <NewTest selected={selected} cases={filtered} query={query} prompt={casePrompt} preference={preference} onQuery={setQuery} onSelect={chooseCase} onPreference={setPreference} onStart={start}/>
        : <RunView run={activeRun} selected={selected} prompt={casePrompt} steps={steps} events={events} summary={summary}/>}
    </section>
  </main>
}

function MarkdownContent({ children, className = '' }: { children?: string; className?: string }) {
  return <div className={`markdown ${className}`}><Markdown>{children || ''}</Markdown></div>
}

function ToolArgumentView({ action, compact = false }: { action: ParsedAction; compact?: boolean }) {
  const args = action.arguments || {}
  const path = typeof args.path === 'string' ? args.path : null
  const content = typeof args.content === 'string' ? args.content : null
  const extra = Object.fromEntries(Object.entries(args).filter(([key]) => key !== 'path' && key !== 'content'))

  return <div className={`tool-args ${compact ? 'compact' : ''}`}>
    {path && <p><small>PATH</small><code>{path}</code></p>}
    {Object.keys(extra).length > 0 && <details>
      <summary>Other arguments</summary>
      <pre>{prettyJson(extra)}</pre>
    </details>}
    {content && <details>
      <summary>{compact ? 'Preview content' : 'File content'}</summary>
      <pre>{content}</pre>
    </details>}
  </div>
}

function CompletionBody({ run, steps }: { run: Run | null; steps: Step[] }) {
  const action = parseActionPayload(run?.final_answer)
  const lastToolResult = [...steps].reverse().find(step => step.tool?.result)?.tool?.result

  if (run?.status === 'failed') return <MarkdownContent>{run?.error}</MarkdownContent>
  if (action?.type === 'tool') {
    return <div className="completion-card">
      <small>FINAL AGENT ACTION</small>
      <h4>{formatToolAction(action)}</h4>
      {lastToolResult && <p className="completion-note">{lastToolResult}</p>}
      <ToolArgumentView action={action} compact />
    </div>
  }
  return <MarkdownContent>{run?.final_answer}</MarkdownContent>
}

function NewTest({ selected, cases, query, prompt, preference, onQuery, onSelect, onPreference, onStart }: { selected: Case | null; cases: Case[]; query: string; prompt: string; preference: number; onQuery: (value: string) => void; onSelect: (item: Case) => void; onPreference: (value: number) => void; onStart: () => void }) {
  return <>
    <header className="page-head">
      <div>
        <span className="kicker">NEW AGENT TEST</span>
        <h2>Choose a benchmark task</h2>
        <p>Review the task, select the routing policy, then start a fully traced Agent run.</p>
      </div>
    </header>
    <div className="setup-grid">
      <section className="case-picker">
        <input aria-label="Search benchmark cases" placeholder="Search 147 cases" value={query} onChange={event => onQuery(event.target.value)}/>
        <div className="case-options">
          {cases.map(item => <button className={selected?.id === item.id ? 'selected' : ''} key={item.id} onClick={() => onSelect(item)}>
            <span>{item.category}</span>
            <strong>{item.name}</strong>
            <small>{item.grading_type} · {item.timeout_seconds}s</small>
          </button>)}
        </div>
      </section>
      <section className="case-detail">
        <span className="kicker">TASK BRIEF</span>
        <h3>{selected?.name || 'Select a task'}</h3>
        <div className="meta"><span>{selected?.category}</span><span>{selected?.grading_type}</span><span>{selected?.timeout_seconds}s timeout</span></div>
        <MarkdownContent className="prompt">{prompt || 'Loading task prompt…'}</MarkdownContent>
        <label className="preference">
          <span>Routing policy <b>{preferenceCopy[preference - 1]}</b></span>
          <input aria-label="Routing policy" type="range" min="1" max="6" value={preference} onChange={event => onPreference(Number(event.target.value))}/>
          <small>Higher quality priority on the left; lower predicted cost on the right.</small>
        </label>
        <button className="start" disabled={!selected} onClick={onStart}>Start agent run <span>→</span></button>
      </section>
    </div>
  </>
}

function RunView({ run, selected, prompt, steps, events, summary }: { run: Run | null; selected: Case | null; prompt: string; steps: Step[]; events: AgentEvent[]; summary?: Summary }) {
  const terminal = run?.status === 'completed' || run?.status === 'failed'
  return <>
    <header className="page-head run-head">
      <div>
        <span className="kicker">{run?.status === 'running' ? 'AGENT IS WORKING' : 'TEST RUN'}</span>
        <h2>{selected?.name || run?.case_id}</h2>
        <p>{run?.run_id}</p>
      </div>
      <div className={`run-status ${run?.status}`}><i/>{run?.status === 'running' ? 'Running · waiting for next step' : run?.status}</div>
    </header>
    <div className="chat">
      <article className="task-message">
        <span className="avatar">T</span>
        <div>
          <small>PINCHBENCH TASK</small>
          <MarkdownContent className="task-copy">{prompt || 'Task prompt is unavailable for this historical run.'}</MarkdownContent>
        </div>
      </article>
      {steps.map(step => <StepCard key={step.index} step={step}/>)}
      {!terminal && <article className="waiting">
        <span className="pulse"/>
        <div>
          <b>{events.some(event => event.event === 'model_call_started') ? 'Model provider is working on the next Agent step' : 'Preparing the next Router decision'}</b>
          <small>The run stays live. A new step appears as soon as the model or tool returns.</small>
        </div>
      </article>}
      {terminal && <SummaryCard run={run} summary={summary} steps={steps}/>}
    </div>
  </>
}

function StepCard({ step }: { step: Step }) {
  const action = step.response?.action
  const candidates = step.route?.candidates || []
  return <article className="step-card">
    <div className="step-top">
      <span>STEP {step.index + 1}</span>
      <b>{step.route?.routed_label || 'Selecting model'}</b>
      <small>{step.route ? `${((candidates[0]?.probability || 0) * 100).toFixed(1)}% top probability` : ''}</small>
      {step.route && <details>
        <summary>Router scorecard</summary>
        <div className="route-grid">
          {candidates.slice(0, 4).map(candidate => <div key={candidate.label}>
            <b>{candidate.label}</b>
            <span>{(candidate.probability * 100).toFixed(1)}% probability</span>
            <small>quality {candidate.predicted_quality.toFixed(2)} · est. {money(candidate.predicted_cost)}</small>
          </div>)}
        </div>
      </details>}
    </div>
    {step.calling && !step.response && <div className="model-wait"><span className="pulse"/> Router selected <b>{step.calling.routed_label}</b>; calling {step.calling.executed_model}…</div>}
    {step.response && <div className="step-body">
      {step.response.reasoning && <details className="think">
        <summary>Agent reasoning</summary>
        <MarkdownContent>{step.response.reasoning}</MarkdownContent>
      </details>}
      {action?.type === 'tool' && <div className="tool-pair">
        <div className="tool-call">
          <small>TOOL CALL</small>
          <b>{action.name}</b>
          <ToolArgumentView action={action} />
        </div>
        <div className="tool-result">
          <small>TOOL RESULT</small>
          {step.tool
            ? <><b>{step.tool.tool}</b><MarkdownContent>{step.tool.result}</MarkdownContent></>
            : <p className="pending">Waiting for tool execution…</p>}
        </div>
      </div>}
      {action?.type === 'final' && <div className="final-message"><small>AGENT RESPONSE</small><MarkdownContent>{action.answer}</MarkdownContent></div>}
      {!action?.type && <div className="final-message"><small>MODEL RESPONSE</small><MarkdownContent>{step.response.content}</MarkdownContent></div>}
    </div>}
  </article>
}

function SummaryCard({ run, summary, steps }: { run: Run | null; summary?: Summary; steps: Step[] }) {
  return <article className="summary">
    <span className="avatar success">✓</span>
    <div>
      <small>RUN SUMMARY</small>
      <h3>{run?.status === 'completed' ? 'Task completed' : 'Run failed'}</h3>
      <CompletionBody run={run} steps={steps}/>
      <div className="summary-stats">
        <span><b>{summary?.steps ?? steps.length}</b> model steps</span>
        <span><b>{money(summary?.router_estimated_cost)}</b> estimated route cost</span>
        <span><b>{summary?.tools?.join(', ') || 'No tools'}</b> tools used</span>
        <span><b>{summary?.routed_models?.join(', ') || '—'}</b> routed models</span>
      </div>
    </div>
  </article>
}

createRoot(document.getElementById('root')!).render(<App />)
