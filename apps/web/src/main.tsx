import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { createRoot } from 'react-dom/client'
import Markdown from 'react-markdown'
import './styles.css'

type Case = { id: string; name: string; category: string; grading_type: string; timeout_seconds: number }
type Candidate = { label: string; probability: number; predicted_quality: number; predicted_cost: number; predicted_output_tokens?: number; score?: number }
type ModelStat = { model_label: string; executed_model?: string; steps: number; actual_cost: number; input_tokens: number; cache_tokens: number; output_tokens: number; total_latency_ms: number; avg_latency_ms: number }
type ModelInfo = { label: string; input_price_per_million: number; output_price_per_million: number; latency_seconds: number; execution_profile: string; model_name: string }
type Grade = { task_id: string; score: number; max_score: number; grading_type: string; breakdown: Record<string, number>; notes: string }
type Summary = { steps: number; router_estimated_cost: number; actual_cost?: number; total_latency_ms?: number; total_input_tokens?: number; total_cache_tokens?: number; total_output_tokens?: number; routed_models: string[]; tools: string[]; model_stats?: ModelStat[]; grade?: Grade }
type Run = { run_id: string; case_id: string; status: 'queued' | 'running' | 'completed' | 'failed'; created_at: string; final_answer?: string; error?: string; summary?: Summary; request?: { mode?: 'router' | 'model'; selected_model?: string } }
type ParsedAction = { type?: string; name?: string; arguments?: Record<string, unknown>; answer?: string }
type AgentEvent = { event: string; sequence?: number; step?: number; routed_label?: string; candidates?: Candidate[]; executed_model?: string; router_latency_ms?: number; model_latency_ms?: number; content?: string; reasoning?: string; action?: ParsedAction; tool?: string; result?: string; final_answer?: string; error?: string; grade?: Grade; usage?: Record<string, any>; input_price_per_million?: number; output_price_per_million?: number }
type Step = { index: number; route?: AgentEvent; calling?: AgentEvent; response?: AgentEvent; tool?: AgentEvent }

function getRunStrategy(run: Run): {
  mode: 'router' | 'model'
  label: string
  colorClass: 'strategy-router' | 'strategy-flash' | 'strategy-pro'
} {
  const reqMode = run.request?.mode
  const selected = run.request?.selected_model || ''
  if (reqMode === 'model' && selected) {
    const isFlash = selected.includes('flash')
    return {
      mode: 'model',
      label: selected,
      colorClass: isFlash ? 'strategy-flash' : 'strategy-pro',
    }
  }

  return {
    mode: 'router',
    label: 'Router',
    colorClass: 'strategy-router',
  }
}

function RouterIcon({ className = 'svg-icon' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="2" y="2" width="6" height="6" rx="1" />
      <rect x="16" y="2" width="6" height="6" rx="1" />
      <rect x="9" y="16" width="6" height="6" rx="1" />
      <path d="M5 8v3a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8" />
      <path d="M12 13v3" />
    </svg>
  )
}

function TargetIcon({ className = 'svg-icon' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="5" />
      <line x1="12" y1="1" x2="12" y2="3" />
      <line x1="12" y1="21" x2="12" y2="23" />
      <line x1="1" y1="12" x2="3" y2="12" />
      <line x1="21" y1="12" x2="23" y2="12" />
    </svg>
  )
}

function FlashIcon({ className = 'svg-icon' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
    </svg>
  )
}

function ProChipIcon({ className = 'svg-icon' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="4" y="4" width="16" height="16" rx="2" />
      <rect x="9" y="9" width="6" height="6" />
      <path d="M9 1v3M15 1v3M9 20v3M15 20v3M20 9h3M20 15h3M1 9h3M1 15h3" />
    </svg>
  )
}

function FolderIcon({ isOpen, className = 'svg-icon' }: { isOpen: boolean; className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d={isOpen ? "M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" : "M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"} />
    </svg>
  )
}

function StarIcon({ filled, className = 'svg-icon' }: { filled: boolean; className?: string }) {
  return (
    <svg
      className={`${className} star-icon ${filled ? 'filled' : 'empty'}`}
      viewBox="0 0 24 24"
      fill={filled ? 'currentColor' : 'none'}
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
    </svg>
  )
}

function ModelIcon({ label, className = 'svg-icon' }: { label: string; className?: string }) {
  if (label.includes('flash')) return <FlashIcon className={`${className} icon-flash`} />
  if (label.includes('pro')) return <ProChipIcon className={`${className} icon-pro`} />
  return <TargetIcon className={className} />
}

type RunReport = {
  total_cost: number
  total_latency_ms: number
  total_input_tokens: number
  total_cache_tokens: number
  total_output_tokens: number
  total_steps: number
  routed_models: string[]
  model_stats: ModelStat[]
  grade?: Grade
}

const api = import.meta.env.VITE_API_URL || ''
const money = (value?: number) => {
  if (!value || value === 0) return '$0.00'
  if (value < 0.000001) return `$${value.toFixed(8)}`
  if (value < 0.0001) return `$${value.toFixed(6)}`
  if (value < 0.01) return `$${value.toFixed(5)}`
  return `$${value.toFixed(4)}`
}
const formatLatency = (ms?: number) => {
  if (!ms || ms === 0) return '0ms'
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(2)}s`
}
const formatTokens = (num?: number) => (num || 0).toLocaleString()
const scoreValue = (grade?: Grade) => grade ? `${grade.score.toFixed(2)} / ${Math.max(grade.max_score || 1, 1).toFixed(2)}` : '—'
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
  const [executionMode, setExecutionMode] = useState<'router' | 'model'>('router')
  const [selectedModel, setSelectedModel] = useState<string>('deepseek-v4-flash')
  const [theme, setTheme] = useState<'dark' | 'light'>(() => {
    const saved = localStorage.getItem('router_lab_theme')
    if (saved === 'dark' || saved === 'light') return saved
    return window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
  })
  const [availableModels, setAvailableModels] = useState<ModelInfo[]>([])
  const [starredIds, setStarredIds] = useState<string[]>(() => {
    try {
      return JSON.parse(localStorage.getItem('pinchbench_favorites') || '[]')
    } catch {
      return []
    }
  })
  const [events, setEvents] = useState<AgentEvent[]>([])
  const [activeRun, setActiveRun] = useState<Run | null>(null)
  const [screen, setScreen] = useState<'new' | 'run' | 'compare'>('new')
  const [compareIds, setCompareIds] = useState<string[]>([])
  const [isCompareModalOpen, setIsCompareModalOpen] = useState(false)
  const steps = useMemo(() => toSteps(events), [events])
  const filtered = useMemo(() => cases.filter(item => `${item.name} ${item.category}`.toLowerCase().includes(query.toLowerCase())), [cases, query])

  useEffect(() => {
    document.documentElement.dataset.theme = theme
    localStorage.setItem('router_lab_theme', theme)
  }, [theme])

  function toggleStar(caseId: string, e: React.MouseEvent) {
    e.stopPropagation()
    setStarredIds(prev => {
      const next = prev.includes(caseId) ? prev.filter(id => id !== caseId) : [...prev, caseId]
      try {
        localStorage.setItem('pinchbench_favorites', JSON.stringify(next))
      } catch {}
      return next
    })
  }

  useEffect(() => {
    Promise.all([
      fetch(`${api}/api/cases`).then(r => r.json()),
      fetch(`${api}/api/runs`).then(r => r.json()),
      fetch(`${api}/api/models`).then(r => r.json()).catch(() => ({ items: [] }))
    ]).then(([caseData, runData, modelData]) => {
      setCases(caseData.items)
      setRuns(runData.items)
      if (modelData?.items?.length > 0) {
        setAvailableModels(modelData.items)
        setSelectedModel(modelData.items[0].label)
      }
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
    const candidateLabels = executionMode === 'model' ? [selectedModel] : null
    const response = await fetch(`${api}/api/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        case_id: selected.id,
        mode: executionMode,
        selected_model: executionMode === 'model' ? selectedModel : null,
        preference,
        candidate_labels: candidateLabels,
        max_steps: 8,
      }),
    })
    const payload = await response.json()
    if (!response.ok) {
      setEvents([{ event: 'run_failed', error: payload.detail || 'Could not create run' }])
      return
    }
    const run: Run = {
      run_id: payload.run_id,
      case_id: selected.id,
      status: 'running',
      created_at: new Date().toISOString(),
      request: { mode: executionMode, selected_model: executionMode === 'model' ? selectedModel : undefined }
    }
    setActiveRun(run)
    setRuns(previous => [run, ...previous])
    setScreen('run')
    const source = new EventSource(`${api}${payload.events_url}`)
    ;['run_started', 'router_decision', 'model_call_started', 'model_response', 'tool_result', 'grading_started', 'run_completed', 'run_failed'].forEach(name => source.addEventListener(name, message => {
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
  const compareRuns = useMemo(() => runs.filter(r => compareIds.includes(r.run_id)), [runs, compareIds])

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <div className="brand"><span>PINCHBENCH × ROUTING</span><h1>Router<i>Lab</i></h1></div>
        <div className="sidebar-action-group">
          <button className="new-test" onClick={newTest}>＋ New test</button>
          <button className={`compare-test-btn ${screen === 'compare' ? 'active' : ''}`} onClick={() => setIsCompareModalOpen(true)}>
            <TargetIcon className="svg-icon" /> Compare runs {compareIds.length > 0 && <span className="compare-count-pill">{compareIds.length}</span>}
          </button>
          <button className="theme-toggle" onClick={() => setTheme(current => current === 'dark' ? 'light' : 'dark')}>
            {theme === 'dark' ? '☀ Light theme' : '◐ Dark theme'}
          </button>
        </div>
        <div className="history-label">RUN HISTORY <b>{runs.length}</b></div>
        <div className="history">
          {runs.length === 0 && <p className="history-empty">Your completed tests will live here.</p>}
          {runs.map((run, idx) => (
            <HistoryRowItem
              key={run.run_id}
              run={run}
              runIndex={runs.length - idx}
              caseName={cases.find(item => item.id === run.case_id)?.name || run.case_id}
              isActive={activeRun?.run_id === run.run_id}
              onOpen={() => openRun(run)}
              onDelete={() => deleteRun(run)}
            />
          ))}
        </div>
      </aside>
      <section className="conversation">
        {screen === 'new' && (
          <NewTest
            selected={selected}
            cases={filtered}
            query={query}
            prompt={casePrompt}
            preference={preference}
            executionMode={executionMode}
            selectedModel={selectedModel}
            availableModels={availableModels}
            starredIds={starredIds}
            onQuery={setQuery}
            onSelect={chooseCase}
            onPreference={setPreference}
            onExecutionMode={setExecutionMode}
            onSelectedModel={setSelectedModel}
            onToggleStar={toggleStar}
            onStart={start}
          />
        )}
        {screen === 'run' && (
          <RunView run={activeRun} selected={selected} prompt={casePrompt} steps={steps} events={events} summary={summary} />
        )}
        {screen === 'compare' && (
          <ComparisonView
            compareRuns={compareRuns}
            cases={cases}
            api={api}
            onBack={newTest}
            onChangeSelection={() => setIsCompareModalOpen(true)}
          />
        )}
      </section>

      {isCompareModalOpen && (
        <CompareModal
          runs={runs}
          cases={cases}
          initialSelected={compareIds}
          onClose={() => setIsCompareModalOpen(false)}
          onConfirm={(selectedRunIds) => {
            setCompareIds(selectedRunIds)
            setIsCompareModalOpen(false)
            setScreen('compare')
          }}
        />
      )}
    </main>
  )
}

function HistoryRowItem({
  run,
  runIndex,
  caseName,
  isActive,
  onOpen,
  onDelete,
}: {
  run: Run
  runIndex: number
  caseName: string
  isActive: boolean
  onOpen: () => void
  onDelete: () => void
}) {
  const [showConfirm, setShowConfirm] = useState(false)
  const [popoverPos, setPopoverPos] = useState<{ top: number; left: number }>({ top: 0, left: 0 })
  const btnRef = useRef<HTMLButtonElement>(null)
  const portalRef = useRef<HTMLDivElement>(null)
  const isDeletable = run.status !== 'running' && run.status !== 'queued'

  const strategy = useMemo(() => getRunStrategy(run), [run])

  useEffect(() => {
    if (!showConfirm) return
    function handleClickOutside(event: MouseEvent) {
      const target = event.target as Node
      if (
        portalRef.current &&
        !portalRef.current.contains(target) &&
        btnRef.current &&
        !btnRef.current.contains(target)
      ) {
        setShowConfirm(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [showConfirm])

  const handleTriggerClick = (e: React.MouseEvent<HTMLButtonElement>) => {
    e.stopPropagation()
    if (!showConfirm && btnRef.current) {
      const rect = btnRef.current.getBoundingClientRect()
      setPopoverPos({
        top: Math.max(20, Math.min(window.innerHeight - 120, rect.top + rect.height / 2)),
        left: Math.min(window.innerWidth - 240, rect.right + 12),
      })
    }
    setShowConfirm(!showConfirm)
  }

  const statusLabel = run.status === 'completed' ? 'Completed'
    : run.status === 'running' ? 'In Progress'
    : run.status === 'queued' ? 'Queued'
    : 'Failed'

  return (
    <div className={`history-row ${showConfirm ? 'confirming' : ''} ${strategy.colorClass}`}>
      <button className={`history-item ${isActive ? 'active' : ''}`} onClick={onOpen}>
        <span className={`dot ${run.status}`} />
        <div className="history-item-body">
          {/* Line 1: task name + run number */}
          <div className="history-line-1">
            <span className="history-case-title">{caseName}</span>
            <span className="run-seq-id">#{runIndex}</span>
          </div>
          {/* Line 2: model + status */}
          <div className="history-line-2">
            <span className={`strategy-badge ${strategy.colorClass}`}>{strategy.label}</span>
            <span className={`run-status-label ${run.status}`}>{statusLabel}</span>
          </div>
          {/* Line 3: timestamp */}
          <div className="history-line-3">
            {new Date(run.created_at).toLocaleString()}
          </div>
        </div>
      </button>

      {isDeletable && (
        <button
          ref={btnRef}
          className={`delete-run ${showConfirm ? 'active' : ''}`}
          title="Delete saved run"
          aria-label={`Delete ${caseName}`}
          onClick={handleTriggerClick}
        >
          ×
        </button>
      )}

      {showConfirm &&
        createPortal(
          <div
            ref={portalRef}
            className="sidebar-delete-portal"
            style={{ top: `${popoverPos.top}px`, left: `${popoverPos.left}px` }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="portal-card-header">
              <strong>Delete run?</strong>
              <small>“{caseName}” will be permanently removed.</small>
            </div>
            <div className="portal-card-actions">
              <button className="portal-btn cancel" onClick={() => setShowConfirm(false)}>
                Cancel
              </button>
              <button
                className="portal-btn danger"
                onClick={() => {
                  setShowConfirm(false)
                  onDelete()
                }}
              >
                Delete
              </button>
            </div>
            <div className="portal-arrow" />
          </div>,
          document.body
        )}
    </div>
  )
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

function CategoryFolderGroup({
  category,
  items,
  selectedId,
  isSearching,
  starredIds,
  onSelect,
  onToggleStar,
}: {
  category: string
  items: Case[]
  selectedId?: string
  isSearching: boolean
  starredIds: string[]
  onSelect: (item: Case) => void
  onToggleStar: (caseId: string, e: React.MouseEvent) => void
}) {
  const hasSelected = useMemo(() => items.some(item => item.id === selectedId), [items, selectedId])
  const [isOpen, setIsOpen] = useState(hasSelected || isSearching)

  useEffect(() => {
    if (hasSelected || isSearching) {
      setIsOpen(true)
    }
  }, [hasSelected, isSearching])

  const sortedItems = useMemo(() => {
    return [...items].sort((a, b) => {
      const aStarred = starredIds.includes(a.id)
      const bStarred = starredIds.includes(b.id)
      if (aStarred && !bStarred) return -1
      if (!aStarred && bStarred) return 1
      return 0
    })
  }, [items, starredIds])

  return (
    <div className={`category-folder ${isOpen ? 'open' : 'closed'}`}>
      <div
        className="folder-header"
        onClick={() => setIsOpen(!isOpen)}
        role="button"
        tabIndex={0}
      >
        <span className="folder-chevron">{isOpen ? '▾' : '▸'}</span>
        <span className="folder-icon"><FolderIcon isOpen={isOpen} /></span>
        <span className="folder-name">{category}</span>
        <span className="folder-count">{items.length}</span>
      </div>

      {isOpen && (
        <div className="folder-contents">
          {sortedItems.map(item => {
            const isStarred = starredIds.includes(item.id)
            return (
              <div
                key={item.id}
                className={`case-item ${selectedId === item.id ? 'selected' : ''} ${isStarred ? 'is-starred' : ''}`}
                onClick={() => onSelect(item)}
                role="button"
                tabIndex={0}
              >
                <strong>{item.name}</strong>
                <button
                  type="button"
                  className={`star-toggle-btn ${isStarred ? 'starred' : ''}`}
                  title={isStarred ? 'Remove from favorites' : 'Add to favorites'}
                  onClick={(e) => onToggleStar(item.id, e)}
                >
                  <StarIcon filled={isStarred} />
                </button>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

function CategoryPicker({
  cases,
  selected,
  query,
  starredIds,
  onSelect,
  onToggleStar,
}: {
  cases: Case[]
  selected: Case | null
  query: string
  starredIds: string[]
  onSelect: (item: Case) => void
  onToggleStar: (caseId: string, e: React.MouseEvent) => void
}) {
  const categoriesMap = useMemo(() => {
    const map = new Map<string, Case[]>()
    for (const item of cases) {
      const cat = item.category || 'OTHER'
      if (!map.has(cat)) map.set(cat, [])
      map.get(cat)!.push(item)
    }
    return map
  }, [cases])

  const categoryEntries = Array.from(categoriesMap.entries())

  return (
    <div className="case-options grouped">
      {categoryEntries.map(([category, items]) => (
        <CategoryFolderGroup
          key={category}
          category={category}
          items={items}
          selectedId={selected?.id}
          isSearching={Boolean(query.trim())}
          starredIds={starredIds}
          onSelect={onSelect}
          onToggleStar={onToggleStar}
        />
      ))}
    </div>
  )
}

function NewTest({
  selected,
  cases,
  query,
  prompt,
  preference,
  executionMode,
  selectedModel,
  availableModels,
  starredIds,
  onQuery,
  onSelect,
  onPreference,
  onExecutionMode,
  onSelectedModel,
  onToggleStar,
  onStart,
}: {
  selected: Case | null
  cases: Case[]
  query: string
  prompt: string
  preference: number
  executionMode: 'router' | 'model'
  selectedModel: string
  availableModels: ModelInfo[]
  starredIds: string[]
  onQuery: (value: string) => void
  onSelect: (item: Case) => void
  onPreference: (value: number) => void
  onExecutionMode: (mode: 'router' | 'model') => void
  onSelectedModel: (model: string) => void
  onToggleStar: (caseId: string, e: React.MouseEvent) => void
  onStart: () => void
}) {
  const getButtonLabel = () => {
    if (executionMode === 'router') {
      return 'Start agent run (Dynamic Router)'
    }
    const matched = availableModels.find(m => m.label === selectedModel)
    return `Start agent run (${matched?.label || selectedModel})`
  }

  return (
    <>
      <header className="page-head">
        <div>
          <span className="kicker">NEW AGENT TEST</span>
          <h2>Choose a benchmark task</h2>
          <p>Review the task, select execution strategy (Router or Specific Model), then start a fully traced Agent run.</p>
        </div>
      </header>
      <div className="setup-grid">
        <section className="case-picker">
          <input
            aria-label="Search benchmark cases"
            placeholder={`Search ${cases.length} cases`}
            value={query}
            onChange={(event) => onQuery(event.target.value)}
          />
          <CategoryPicker
            cases={cases}
            selected={selected}
            query={query}
            starredIds={starredIds}
            onSelect={onSelect}
            onToggleStar={onToggleStar}
          />
        </section>
        <section className="case-detail">
          <span className="kicker">TASK BRIEF</span>
          <h3>{selected?.name || 'Select a task'}</h3>
          <div className="meta">
            <span>{selected?.category}</span>
            <span>{selected?.grading_type}</span>
            <span>{selected?.timeout_seconds}s timeout</span>
          </div>
          <MarkdownContent className="prompt">{prompt || 'Loading task prompt…'}</MarkdownContent>

          <div className="strategy-picker-section">
            <span className="strategy-label">EXECUTION STRATEGY</span>
            <div className="strategy-segmented">
              <button
                type="button"
                className={`strategy-tab ${executionMode === 'router' ? 'active' : ''}`}
                onClick={() => onExecutionMode('router')}
              >
                <span><RouterIcon /> Dynamic Router</span>
              </button>
              <button
                type="button"
                className={`strategy-tab ${executionMode === 'model' ? 'active' : ''}`}
                onClick={() => onExecutionMode('model')}
              >
                <span><TargetIcon /> Specific Model</span>
              </button>
            </div>

            {executionMode === 'router' ? (
              <label className="preference">
                <span>
                  Routing policy <b>{preferenceCopy[preference - 1]}</b>
                </span>
                <input
                  aria-label="Routing policy"
                  type="range"
                  min="1"
                  max="6"
                  value={preference}
                  onChange={(event) => onPreference(Number(event.target.value))}
                />
                <small>Higher quality priority on the left; lower predicted cost on the right.</small>
              </label>
            ) : (
              <div className="model-selection-cards">
                {availableModels.length > 0 ? (
                  availableModels.map(model => (
                    <button
                      key={model.label}
                      type="button"
                      className={`model-option-card ${selectedModel === model.label ? 'selected' : ''}`}
                      onClick={() => onSelectedModel(model.label)}
                    >
                      <div className="model-card-header">
                        <strong className="model-title"><ModelIcon label={model.label} /> {model.label}</strong>
                        <span className="model-card-badge">${model.input_price_per_million}/1M in · ${model.output_price_per_million}/1M out</span>
                      </div>
                    </button>
                  ))
                ) : (
                  <>
                    <button
                      type="button"
                      className={`model-option-card ${selectedModel === 'deepseek-v4-flash' ? 'selected' : ''}`}
                      onClick={() => onSelectedModel('deepseek-v4-flash')}
                    >
                      <div className="model-card-header">
                        <strong className="model-title"><FlashIcon /> deepseek-v4-flash</strong>
                        <span className="model-card-badge">$0.14/1M in · $0.28/1M out</span>
                      </div>
                    </button>
                    <button
                      type="button"
                      className={`model-option-card ${selectedModel === 'deepseek-v4-pro' ? 'selected' : ''}`}
                      onClick={() => onSelectedModel('deepseek-v4-pro')}
                    >
                      <div className="model-card-header">
                        <strong className="model-title"><ProChipIcon /> deepseek-v4-pro</strong>
                        <span className="model-card-badge">$0.43/1M in · $0.87/1M out</span>
                      </div>
                    </button>
                  </>
                )}
              </div>
            )}
          </div>

          <button className="start" disabled={!selected} onClick={onStart}>
            {getButtonLabel()} <span>→</span>
          </button>
        </section>
      </div>
    </>
  )
}

function computeRunReport(events: AgentEvent[], summary?: Summary): RunReport {
  const modelStatsMap = new Map<string, ModelStat>()
  let totalCost = summary?.actual_cost ?? 0
  let totalLatency = summary?.total_latency_ms ?? 0
  let totalInput = summary?.total_input_tokens ?? 0
  let totalCache = summary?.total_cache_tokens ?? 0
  let totalOutput = summary?.total_output_tokens ?? 0
  let totalSteps = summary?.steps ?? 0
  const routedModelsSet = new Set<string>(summary?.routed_models || [])

  if (summary?.model_stats) {
    for (const stat of summary.model_stats) {
      modelStatsMap.set(stat.model_label, { ...stat })
      routedModelsSet.add(stat.model_label)
    }
  }

  let eventSteps = 0
  let eventCost = 0
  let eventLatency = 0
  let eventInput = 0
  let eventCache = 0
  let eventOutput = 0

  for (const event of events) {
    if (event.event === 'router_decision') {
      eventSteps += 1
      if (event.routed_label) routedModelsSet.add(event.routed_label)
      if (event.router_latency_ms) eventLatency += event.router_latency_ms
    }

    if (event.event === 'model_response') {
      const label = event.routed_label || 'unknown'
      routedModelsSet.add(label)
      const existing = modelStatsMap.get(label) || {
        model_label: label,
        executed_model: event.executed_model || label,
        steps: 0,
        actual_cost: 0,
        input_tokens: 0,
        cache_tokens: 0,
        output_tokens: 0,
        total_latency_ms: 0,
        avg_latency_ms: 0,
      }

      existing.steps += 1
      const modelLat = event.model_latency_ms || 0
      existing.total_latency_ms += modelLat
      eventLatency += modelLat

      const usage = event.usage || {}
      const inp = usage.prompt_tokens || usage.input_tokens || 0
      const cacheDetails = usage.prompt_tokens_details || {}
      const cache = usage.prompt_cache_hit_tokens || usage.cached_tokens || usage.cache_read_tokens || (typeof cacheDetails === 'object' ? cacheDetails.cached_tokens : 0) || 0
      let out = usage.completion_tokens || usage.output_tokens || 0

      if (inp === 0 && out === 0) {
        const matched = (event.candidates || []).find(c => c.label === label)
        if (matched) out = Math.round(matched.predicted_output_tokens || 0)
      }

      existing.input_tokens += inp
      existing.cache_tokens += cache
      existing.output_tokens += out

      eventInput += inp
      eventCache += cache
      eventOutput += out

      const inPrice = event.input_price_per_million || 0
      const outPrice = event.output_price_per_million || 0
      let stepCost = 0
      if (inPrice > 0 || outPrice > 0) {
        stepCost = (inp * inPrice / 1_000_000) + (out * outPrice / 1_000_000)
      } else {
        const candidate = (event.candidates || []).find(c => c.label === label)
        stepCost = candidate?.predicted_cost || 0
      }

      existing.actual_cost += stepCost
      eventCost += stepCost

      modelStatsMap.set(label, existing)
    }
  }

  if (modelStatsMap.size > 0) {
    for (const stat of modelStatsMap.values()) {
      if (stat.steps > 0) {
        stat.avg_latency_ms = Math.round(stat.total_latency_ms / stat.steps)
      }
    }
    totalCost = eventCost
    totalLatency = eventLatency
    totalInput = eventInput
    totalCache = eventCache
    totalOutput = eventOutput
    totalSteps = eventSteps
  }

  return {
    total_cost: totalCost,
    total_latency_ms: totalLatency,
    total_input_tokens: totalInput,
    total_cache_tokens: totalCache,
    total_output_tokens: totalOutput,
    total_steps: totalSteps,
    routed_models: Array.from(routedModelsSet),
    model_stats: Array.from(modelStatsMap.values()),
    grade: summary?.grade,
  }
}

function ExecutionReportCard({ report, status }: { report: RunReport; status?: string }) {
  const isFailed = status === 'failed'

  return (
    <section className={`top-execution-report ${isFailed ? 'failed' : 'completed'}`}>
      <div className="report-header">
        <div className="report-title">
          <span className={`status-badge ${isFailed ? 'failed' : 'completed'}`}>
            {isFailed ? '✕ RUN FAILED' : '✓ RUN COMPLETED'}
          </span>
          <h3>Task Execution Report</h3>
        </div>
        <div className="report-models-tags">
          {report.routed_models.map(model => (
            <span key={model} className="model-chip">
              <ModelIcon label={model} /> {model}
            </span>
          ))}
        </div>
      </div>

      <div className="report-metrics-grid">
        <div className="metric-card highlight-score">
          <small>SCORE</small>
          <strong>{scoreValue(report.grade)}</strong>
          <span className="metric-sub">{report.grade ? `${report.grade.grading_type.replace('_', ' ')} evaluation` : 'Grading unavailable'}</span>
        </div>
        <div className="metric-card highlight-cost">
          <small>TOTAL COST</small>
          <strong>{money(report.total_cost)}</strong>
          <span className="metric-sub">Actual run cost</span>
        </div>

        <div className="metric-card highlight-latency">
          <small>TOTAL LATENCY</small>
          <strong>{formatLatency(report.total_latency_ms)}</strong>
          <span className="metric-sub">Model & router latency</span>
        </div>

        <div className="metric-card highlight-steps">
          <small>TOTAL STEPS</small>
          <strong>{report.total_steps} <small>steps</small></strong>
          <span className="metric-sub">{report.routed_models.length} model{report.routed_models.length > 1 ? 's' : ''} used</span>
        </div>

        <div className="metric-card highlight-tokens">
          <small>TOTAL TOKENS</small>
          <strong>{formatTokens(report.total_input_tokens + report.total_output_tokens)}</strong>
          <span className="metric-sub">
            Input: {formatTokens(report.total_input_tokens)} | Cache: {formatTokens(report.total_cache_tokens)} | Output: {formatTokens(report.total_output_tokens)}
          </span>
        </div>
      </div>

      {report.model_stats.length > 0 && (
        <div className="report-breakdown">
          <h4>Per-Model Execution Breakdown</h4>
          <div className="model-stats-table-wrapper">
            <table className="model-stats-table">
              <thead>
                <tr>
                  <th>MODEL</th>
                  <th>STEPS</th>
                  <th>ACTUAL COST</th>
                  <th>INPUT TOKENS</th>
                  <th>CACHE HIT TOKENS</th>
                  <th>OUTPUT TOKENS</th>
                  <th>TOTAL LATENCY</th>
                  <th>AVG LATENCY</th>
                </tr>
              </thead>
              <tbody>
                {report.model_stats.map(stat => (
                  <tr key={stat.model_label}>
                    <td className="model-name-cell">
                      <strong>{stat.model_label}</strong>
                      {stat.executed_model && stat.executed_model !== stat.model_label && (
                        <small>({stat.executed_model})</small>
                      )}
                    </td>
                    <td><span className="step-badge">{stat.steps} step{stat.steps > 1 ? 's' : ''}</span></td>
                    <td className="cost-cell">{money(stat.actual_cost)}</td>
                    <td>{formatTokens(stat.input_tokens)}</td>
                    <td>
                      <span className={`cache-badge ${stat.cache_tokens > 0 ? 'active' : ''}`}>
                        {formatTokens(stat.cache_tokens)}
                      </span>
                    </td>
                    <td>{formatTokens(stat.output_tokens)}</td>
                    <td>{formatLatency(stat.total_latency_ms)}</td>
                    <td>{formatLatency(stat.avg_latency_ms)} / step</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </section>
  )
}

function RunView({ run, selected, prompt, steps, events, summary }: { run: Run | null; selected: Case | null; prompt: string; steps: Step[]; events: AgentEvent[]; summary?: Summary }) {
  const terminal = run?.status === 'completed' || run?.status === 'failed'
  const grading = !terminal && events.some(event => event.event === 'grading_started')
  const report = useMemo(() => computeRunReport(events, summary), [events, summary])

  return <>
    <header className="page-head run-head">
      <div>
        <span className="kicker">{run?.status === 'running' ? 'AGENT IS WORKING' : 'TEST RUN'}</span>
        <h2>{selected?.name || run?.case_id}</h2>
        <p>{run?.run_id}</p>
      </div>
      <div className={`run-status ${run?.status}`}><i/>{grading ? 'Grading · PinchBench is evaluating the result' : run?.status === 'running' ? 'Running · waiting for next step' : run?.status}</div>
    </header>
    {terminal && <ExecutionReportCard report={report} status={run?.status} />}
    <div className="chat">
      <article className="task-message">
        <span className="avatar">T</span>
        <div>
          <small>PINCHBENCH TASK</small>
          <MarkdownContent className="task-copy">{prompt || 'Task prompt is unavailable for this historical run.'}</MarkdownContent>
        </div>
      </article>
      {steps.map(step => <StepCard key={step.index} step={step}/>)}
      {(grading || summary?.grade) && <GradingCard grade={summary?.grade} pending={grading} />}
      {!terminal && <article className="waiting">
        <span className="pulse"/>
        <div>
          <b>{grading ? 'PinchBench is grading this run' : events.some(event => event.event === 'model_call_started') ? 'Model provider is working on the next Agent step' : 'Preparing the next Router decision'}</b>
          <small>{grading ? 'The completed trace and workspace are being evaluated before the final score is saved.' : 'The run stays live. A new step appears as soon as the model or tool returns.'}</small>
        </div>
      </article>}
      {terminal && <SummaryCard run={run} summary={summary} steps={steps}/>}
    </div>
  </>
}

function GradingCard({ grade, pending }: { grade?: Grade; pending: boolean }) {
  const breakdown = Object.entries(grade?.breakdown || {})
  return <article className={`grading-card ${pending ? 'pending' : ''}`}>
    <div className="grading-card-head">
      <span className={`grading-icon ${pending ? 'pending' : ''}`}>{pending ? '◌' : '✓'}</span>
      <div>
        <small>PINCHBENCH EVALUATION</small>
        <h3>{pending ? 'Scoring the completed run…' : `${scoreValue(grade)} score`}</h3>
      </div>
      {grade && <span className="grading-type">{grade.grading_type.replace('_', ' ')}</span>}
    </div>
    {pending ? (
      <p>The trace and workspace are now being evaluated by PinchBench.</p>
    ) : (
      <>
        {breakdown.length > 0 && <div className="grade-breakdown">
          {breakdown.map(([criterion, score]) => <div key={criterion}>
            <span>{criterion.replace(/[._]/g, ' ')}</span>
            <b>{score.toFixed(2)} / 1.00</b>
          </div>)}
        </div>}
        {grade?.notes && <p className="grade-notes">{grade.notes}</p>}
      </>
    )}
  </article>
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
        <span><b>{scoreValue(summary?.grade)}</b> score</span>
        <span><b>{summary?.steps ?? steps.length}</b> model steps</span>
        <span><b>{money(summary?.router_estimated_cost)}</b> estimated route cost</span>
        <span><b>{summary?.tools?.join(', ') || 'No tools'}</b> tools used</span>
        <span><b>{summary?.routed_models?.join(', ') || '—'}</b> routed models</span>
      </div>
    </div>
  </article>
}

function CompareModal({
  runs,
  cases,
  initialSelected,
  onClose,
  onConfirm,
}: {
  runs: Run[]
  cases: Case[]
  initialSelected: string[]
  onClose: () => void
  onConfirm: (selectedIds: string[]) => void
}) {
  const [selected, setSelected] = useState<string[]>(initialSelected)

  const toggleRun = (runId: string) => {
    setSelected((prev) => {
      if (prev.includes(runId)) {
        return prev.filter((id) => id !== runId)
      }
      if (prev.length >= 3) {
        return prev
      }
      return [...prev, runId]
    })
  }

  const isValid = selected.length >= 2 && selected.length <= 3

  return createPortal(
    <div className="compare-modal-backdrop" onClick={onClose}>
      <div className="compare-modal-card" onClick={(e) => e.stopPropagation()}>
        <div className="compare-modal-header">
          <div>
            <h3>Select Experiments to Compare</h3>
            <p>Pick at least 2 and at most 3 historical test runs to perform radar metrics analysis and side-by-side trace comparison.</p>
          </div>
          <button className="compare-modal-close" onClick={onClose}>×</button>
        </div>

        <div className="compare-modal-body">
          {runs.length === 0 ? (
            <p className="compare-empty">No test runs available. Run a few tests first to compare results!</p>
          ) : (
            <div className="compare-runs-list">
              {runs.map((run) => {
                const caseName = cases.find((c) => c.id === run.case_id)?.name || run.case_id
                const isSelected = selected.includes(run.run_id)
                const strategy = getRunStrategy(run)
                const isDisabled = !isSelected && selected.length >= 3

                return (
                  <div
                    key={run.run_id}
                    className={`compare-run-item ${isSelected ? 'selected' : ''} ${isDisabled ? 'disabled' : ''}`}
                    onClick={() => !isDisabled && toggleRun(run.run_id)}
                  >
                    <div className="compare-item-checkbox">
                      <span className={`checkbox-custom ${isSelected ? 'checked' : ''}`}>
                        {isSelected ? '✓' : ''}
                      </span>
                    </div>
                    <div className="compare-item-info">
                      <div className="compare-item-header">
                        <strong>{caseName}</strong>
                        <span className={`strategy-badge ${strategy.colorClass}`}>
                          {strategy.label}
                        </span>
                      </div>
                      <small>
                        {run.status} · {new Date(run.created_at).toLocaleString()} · {run.run_id}
                      </small>
                    </div>
                  </div>
                )
              })}
            </div>
          )}
        </div>

        <div className="compare-modal-footer">
          <span className="compare-counter">
            Selected: <b>{selected.length} / 3</b> (Min 2 required)
          </span>
          <div className="compare-footer-actions">
            <button className="compare-btn cancel" onClick={onClose}>
              Cancel
            </button>
            <button
              className="compare-btn confirm"
              disabled={!isValid}
              onClick={() => onConfirm(selected)}
            >
              Launch Comparison →
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  )
}

function RadarChart({ runs, cases }: { runs: Run[]; cases: Case[] }) {
  const [focusedRunId, setFocusedRunId] = useState<string | null>(null)
  const axes = [
    { key: 'speed', label: 'Speed' },
    { key: 'economy', label: 'Economy' },
    { key: 'throughput', label: 'Throughput' },
    { key: 'concision', label: 'Concision' },
    { key: 'score', label: 'Score' },
  ]

  const colorPalette = [
    { stroke: '#5ce6d0', fill: 'rgba(92, 230, 208, 0.22)' },
    { stroke: '#9bdc78', fill: 'rgba(155, 220, 120, 0.20)' },
    { stroke: '#a8a1ff', fill: 'rgba(168, 161, 255, 0.18)' },
  ]

  const runMetrics = useMemo(() => {
    return runs.map((run) => {
      const summary = run.summary
      const cost = summary?.actual_cost || 0.0001
      const latency = summary?.total_latency_ms || 1000
      const steps = summary?.steps || 1
      const output = summary?.total_output_tokens || 50
      const strategy = getRunStrategy(run)

      return {
        run,
        strategy,
        rawSpeed: 10000 / Math.max(100, latency),
        rawEconomy: 0.001 / Math.max(0.00001, cost),
        rawThroughput: output / Math.max(0.1, latency / 1000),
        rawConcision: 1 / Math.max(1, steps),
        pinchScore: summary?.grade ? summary.grade.score / Math.max(summary.grade.max_score || 1, 1) : 0,
      }
    })
  }, [runs])

  const normalizedData = useMemo(() => {
    if (runMetrics.length === 0) return []

    const maxSpeed = Math.max(...runMetrics.map((r) => r.rawSpeed)) || 1
    const maxEconomy = Math.max(...runMetrics.map((r) => r.rawEconomy)) || 1
    const maxThroughput = Math.max(...runMetrics.map((r) => r.rawThroughput)) || 1
    const maxConcision = Math.max(...runMetrics.map((r) => r.rawConcision)) || 1
    return runMetrics.map((m) => {
      return {
        ...m,
        values: [
          Math.min(1, Math.max(0.25, m.rawSpeed / maxSpeed)),
          Math.min(1, Math.max(0.25, m.rawEconomy / maxEconomy)),
          Math.min(1, Math.max(0.25, m.rawThroughput / maxThroughput)),
          Math.min(1, Math.max(0.25, m.rawConcision / maxConcision)),
          Math.min(1, Math.max(0, m.pinchScore)),
        ],
      }
    })
  }, [runMetrics])

  const center = 140
  const radius = 85

  const getCoordinates = (index: number, value: number) => {
    const angle = (index * 2 * Math.PI) / axes.length - Math.PI / 2
    const x = center + radius * value * Math.cos(angle)
    const y = center + radius * value * Math.sin(angle)
    return { x, y }
  }

  const gridLevels = [0.25, 0.5, 0.75, 1.0]

  return (
    <div className="radar-chart-card" onMouseLeave={() => setFocusedRunId(null)}>
      <div className="radar-chart-header">
        <span className="kicker">CAPABILITY BENCHMARK RADAR</span>
        <h4>Model Performance Profile</h4>
        <small>Hover or click a legend item to focus one run</small>
      </div>
      <div className="radar-svg-container">
        <svg viewBox="0 0 280 280" className="radar-svg">
          {gridLevels.map((level) => {
            const points = axes
              .map((_, i) => {
                const { x, y } = getCoordinates(i, level)
                return `${x},${y}`
              })
              .join(' ')
            return (
              <polygon
                key={level}
                points={points}
                fill="none"
                stroke="rgba(255, 255, 255, 0.08)"
                strokeWidth="1"
                strokeDasharray={level < 1 ? '3 3' : undefined}
              />
            )
          })}

          {axes.map((axis, i) => {
            const { x, y } = getCoordinates(i, 1.0)
            const labelCoord = getCoordinates(i, 1.25)
            return (
              <g key={axis.key}>
                <line
                  x1={center}
                  y1={center}
                  x2={x}
                  y2={y}
                  stroke="rgba(255, 255, 255, 0.12)"
                  strokeWidth="1"
                />
                <text
                  x={labelCoord.x}
                  y={labelCoord.y}
                  fill="#9ab097"
                  fontSize="9"
                  fontFamily="DM Mono, monospace"
                  fontWeight="600"
                  textAnchor="middle"
                  dominantBaseline="middle"
                >
                  {axis.label}
                </text>
              </g>
            )
          })}

          {normalizedData.map((d, rIdx) => {
            const palette = colorPalette[rIdx % colorPalette.length]
            const polygonPoints = d.values
              .map((val, i) => {
                const { x, y } = getCoordinates(i, val)
                return `${x},${y}`
              })
              .join(' ')

            return (
              <g
                key={d.run.run_id}
                className={`radar-series ${focusedRunId && focusedRunId !== d.run.run_id ? 'dimmed' : ''}`}
                onMouseEnter={() => setFocusedRunId(d.run.run_id)}
              >
                <polygon
                  points={polygonPoints}
                  fill={palette.fill}
                  stroke={palette.stroke}
                  strokeWidth="2.5"
                />
                {d.values.map((val, i) => {
                  const { x, y } = getCoordinates(i, val)
                  return <circle key={i} cx={x} cy={y} r="3.5" fill={palette.stroke} />
                })}
              </g>
            )
          })}
        </svg>
      </div>

      <div className="radar-legend">
        {normalizedData.map((d, rIdx) => {
          const palette = colorPalette[rIdx % colorPalette.length]
          const caseName = cases.find((c) => c.id === d.run.case_id)?.name || d.run.case_id
          return (
            <button
              key={d.run.run_id}
              type="button"
              className={`legend-item ${focusedRunId === d.run.run_id ? 'focused' : ''}`}
              onMouseEnter={() => setFocusedRunId(d.run.run_id)}
              onFocus={() => setFocusedRunId(d.run.run_id)}
              onClick={() => setFocusedRunId(current => current === d.run.run_id ? null : d.run.run_id)}
            >
              <span className="legend-dot" style={{ background: palette.stroke }} />
              <span className={`strategy-badge ${d.strategy.colorClass}`}>{d.strategy.label}</span>
              <span className="legend-run-id">{caseName}</span>
            </button>
          )
        })}
      </div>
    </div>
  )
}

function ComparisonColumn({ run, caseName, api }: { run: Run; caseName: string; api: string }) {
  const [events, setEvents] = useState<AgentEvent[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let isMounted = true
    fetch(`${api}/api/runs/${run.run_id}/events/history`)
      .then((r) => r.json())
      .then((data) => {
        if (isMounted) {
          setEvents(data.items || [])
          setLoading(false)
        }
      })
      .catch(() => {
        if (isMounted) setLoading(false)
      })
    return () => {
      isMounted = false
    }
  }, [run.run_id, api])

  const steps = useMemo(() => toSteps(events), [events])
  const strategy = useMemo(() => getRunStrategy(run), [run])

  return (
    <div className={`comparison-column ${strategy.colorClass}`}>
      <div className="column-header">
        <div className="column-header-top">
          <span className={`strategy-badge ${strategy.colorClass}`}>{strategy.label}</span>
          <span className={`status-tag ${run.status}`}>{run.status}</span>
        </div>
        <h4>{caseName}</h4>
        <small className="column-run-id">{run.run_id}</small>
      </div>

      {run.final_answer && (
        <div className="column-final-answer">
          <small>FINAL RESULT</small>
          <MarkdownContent>{run.final_answer}</MarkdownContent>
        </div>
      )}

      <div className="column-trace-timeline">
        <span className="trace-timeline-label">EXECUTION STEPS ({steps.length})</span>
        {loading ? (
          <p className="column-loading">Loading step trace…</p>
        ) : (
          <div className="column-steps-list">
            {steps.map((step) => (
              <div key={step.index} className="comparison-step-card">
                <div className="step-card-header">
                  <strong>Step {step.index}</strong>
                  {step.route?.routed_label && (
                    <span className="step-model-tag">
                      <ModelIcon label={step.route.routed_label} /> {step.route.routed_label}
                    </span>
                  )}
                </div>

                {step.calling?.reasoning && (
                  <div className="step-reasoning">
                    <small>THINKING</small>
                    <p>{step.calling.reasoning}</p>
                  </div>
                )}

                {step.response?.action && (
                  <div className="step-action">
                    <small>ACTION</small>
                    <code>{formatToolAction(step.response.action)}</code>
                  </div>
                )}

                {step.tool?.result && (
                  <div className="step-tool-result">
                    <small>TOOL OUTPUT</small>
                    <pre>{step.tool.result}</pre>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

// ── Head-to-head bar comparison (2-run mode, football-stats style) ──────────
type H2HRow = {
  label: string
  a: number
  b: number
  format: (v: number) => string
}

function HeadToHeadBars({ runs, cases }: { runs: Run[]; cases: Case[] }) {
  const [a, b] = runs
  const stratA = getRunStrategy(a)
  const stratB = getRunStrategy(b)
  const nameA = cases.find((c) => c.id === a.case_id)?.name || a.case_id
  const nameB = cases.find((c) => c.id === b.case_id)?.name || b.case_id

  const rows: H2HRow[] = [
    {
      label: 'Score',
      a: a.summary?.grade ? a.summary.grade.score / Math.max(a.summary.grade.max_score || 1, 1) : 0,
      b: b.summary?.grade ? b.summary.grade.score / Math.max(b.summary.grade.max_score || 1, 1) : 0,
      format: (v) => `${v.toFixed(2)} / 1.00`,
    },
    {
      label: 'Total Cost',
      a: a.summary?.actual_cost ?? 0,
      b: b.summary?.actual_cost ?? 0,
      format: money,
    },
    {
      label: 'Total Latency',
      a: a.summary?.total_latency_ms ?? 0,
      b: b.summary?.total_latency_ms ?? 0,
      format: (v) => formatLatency(v),
    },
    {
      label: 'Steps',
      a: a.summary?.steps ?? 0,
      b: b.summary?.steps ?? 0,
      format: (v) => `${v}`,
    },
    {
      label: 'Input Tokens',
      a: a.summary?.total_input_tokens ?? 0,
      b: b.summary?.total_input_tokens ?? 0,
      format: (v) => formatTokens(v),
    },
    {
      label: 'Output Tokens',
      a: a.summary?.total_output_tokens ?? 0,
      b: b.summary?.total_output_tokens ?? 0,
      format: (v) => formatTokens(v),
    },
    {
      label: 'Cache Hit Tokens',
      a: a.summary?.total_cache_tokens ?? 0,
      b: b.summary?.total_cache_tokens ?? 0,
      format: (v) => formatTokens(v),
    },
  ]

  return (
    <div className="h2h-wrapper">
      {/* Header */}
      <div className="h2h-header">
        <div className="h2h-team-a">
          <span className={`strategy-badge ${stratA.colorClass}`}>{stratA.label}</span>
          <span className="h2h-team-name">{nameA}</span>
        </div>
        <div className="h2h-center-label">VS</div>
        <div className="h2h-team-b">
          <span className="h2h-team-name">{nameB}</span>
          <span className={`strategy-badge ${stratB.colorClass}`}>{stratB.label}</span>
        </div>
      </div>

      {/* Rows */}
      {rows.map(({ label, a: va, b: vb, format }) => {
        const total = va + vb
        const pctA = total === 0 ? 50 : Math.round((va / total) * 100)
        const pctB = 100 - pctA
        return (
          <div key={label} className="h2h-row">
            <div className="h2h-values">
              <span className="h2h-val-a">{format(va)}</span>
              <span className="h2h-metric-label">{label}</span>
              <span className="h2h-val-b">{format(vb)}</span>
            </div>
            <div className="h2h-bar-track">
              <div
                className="h2h-bar h2h-bar-a"
                style={{ width: `${pctA}%` }}
              />
              <div
                className="h2h-bar h2h-bar-b"
                style={{ width: `${pctB}%` }}
              />
            </div>
          </div>
        )
      })}
    </div>
  )
}

function ScoreComparison({ runs, cases }: { runs: Run[]; cases: Case[] }) {
  const criteria = Array.from(new Set(runs.flatMap((run) => Object.keys(run.summary?.grade?.breakdown || {}))))

  return (
    <section className={`score-comparison-card runs-${runs.length}`} aria-label="PinchBench score comparison">
      <header className="score-comparison-header">
        <div>
          <span className="kicker">PINCHBENCH EVALUATION</span>
          <h3>Score Comparison</h3>
        </div>
        <p>Scores and judge feedback aligned across selected runs.</p>
      </header>
      <div className="score-comparison-grid" style={{ gridTemplateColumns: `minmax(160px, .72fr) repeat(${runs.length}, minmax(0, 1fr))` }}>
        <div className="score-grid-heading">METRIC</div>
        {runs.map((run) => {
          const strategy = getRunStrategy(run)
          const caseName = cases.find((c) => c.id === run.case_id)?.name || run.case_id
          return <div className="score-grid-run" key={run.run_id}>
            <span className={`strategy-badge ${strategy.colorClass}`}>{strategy.label}</span>
            <strong>{caseName}</strong>
          </div>
        })}

        <div className="score-grid-label">Score</div>
        {runs.map((run) => <div className="score-grid-value score-total" key={run.run_id}>{scoreValue(run.summary?.grade)}</div>)}

        <div className="score-grid-label">Judge</div>
        {runs.map((run) => <div className="score-grid-value score-type" key={run.run_id}>
          {run.summary?.grade?.grading_type.replace('_', ' ') || 'Unavailable'}
        </div>)}

        {criteria.map((criterion) => <Fragment key={criterion}>
          <div className="score-grid-label">{criterion.replace(/[._]/g, ' ')}</div>
          {runs.map((run) => {
            const value = run.summary?.grade?.breakdown?.[criterion]
            return <div className="score-grid-value" key={`${run.run_id}-${criterion}`}>{value === undefined ? '—' : `${value.toFixed(2)} / 1.00`}</div>
          })}
        </Fragment>)}

        <div className="score-grid-label score-notes-label">Judge notes</div>
        {runs.map((run) => <div className="score-grid-value score-notes" key={`${run.run_id}-notes`}>
          {run.summary?.grade?.notes || 'No score has been saved for this run.'}
        </div>)}
      </div>
    </section>
  )
}

function ComparisonView({
  compareRuns,
  cases,
  api,
  onBack,
  onChangeSelection,
}: {
  compareRuns: Run[]
  cases: Case[]
  api: string
  onBack: () => void
  onChangeSelection: () => void
}) {
  return (
    <div className="comparison-page">
      <header className="page-head comparison-head">
        <div>
          <span className="kicker">EXPERIMENT COMPARISON</span>
          <h2>Comparing {compareRuns.length} Test Runs</h2>
          <p>Analyze radar metrics, token efficiency, cost breakdown, and side-by-side execution flows.</p>
        </div>
        <div className="comparison-head-actions">
          <button className="compare-head-btn secondary" onClick={onChangeSelection}>
            Change Selection
          </button>
          <button className="compare-head-btn primary" onClick={onBack}>
            Exit Comparison
          </button>
        </div>
      </header>

      {/* Part 1: Top Overall Comparison Summary & Radar Chart */}
      <section className="comparison-top-section">
        <RadarChart runs={compareRuns} cases={cases} />

        <div className="comparison-table-card">
          <div className="table-card-header">
            <span className="kicker">METRICS SUMMARY MATRIX</span>
            <h4>Side-by-Side Run Benchmarks</h4>
          </div>
          {compareRuns.length === 2 ? (
            <HeadToHeadBars runs={compareRuns} cases={cases} />
          ) : (
          <div className="comparison-table-wrapper">
            <table className="comparison-table">
              <thead>
                <tr>
                  <th>METRIC</th>
                  {compareRuns.map((run) => {
                    const strategy = getRunStrategy(run)
                    const caseName = cases.find((c) => c.id === run.case_id)?.name || run.case_id
                    return (
                      <th key={run.run_id}>
                        <div className="table-th-content">
                          <span className={`strategy-badge ${strategy.colorClass}`}>
                            {strategy.label}
                          </span>
                          <strong>{caseName}</strong>
                        </div>
                      </th>
                    )
                  })}
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td className="metric-label">Execution Strategy</td>
                  {compareRuns.map((r) => (
                    <td key={r.run_id}>
                      <b>{getRunStrategy(r).label}</b>
                    </td>
                  ))}
                </tr>
                <tr>
                  <td className="metric-label">Status</td>
                  {compareRuns.map((r) => (
                    <td key={r.run_id}>
                      <span className={`status-badge ${r.status}`}>{r.status}</span>
                    </td>
                  ))}
                </tr>
                <tr>
                  <td className="metric-label">Score</td>
                  {compareRuns.map((r) => (
                    <td key={r.run_id} className="score-highlight">{scoreValue(r.summary?.grade)}</td>
                  ))}
                </tr>
                <tr>
                  <td className="metric-label">Total Cost</td>
                  {compareRuns.map((r) => (
                    <td key={r.run_id} className="cost-highlight">
                      {money(r.summary?.actual_cost)}
                    </td>
                  ))}
                </tr>
                <tr>
                  <td className="metric-label">Total Latency</td>
                  {compareRuns.map((r) => (
                    <td key={r.run_id}>{formatLatency(r.summary?.total_latency_ms)}</td>
                  ))}
                </tr>
                <tr>
                  <td className="metric-label">Total Steps</td>
                  {compareRuns.map((r) => (
                    <td key={r.run_id}>{r.summary?.steps || 0} steps</td>
                  ))}
                </tr>
                <tr>
                  <td className="metric-label">Input Tokens</td>
                  {compareRuns.map((r) => (
                    <td key={r.run_id}>{formatTokens(r.summary?.total_input_tokens)}</td>
                  ))}
                </tr>
                <tr>
                  <td className="metric-label">Output Tokens</td>
                  {compareRuns.map((r) => (
                    <td key={r.run_id}>{formatTokens(r.summary?.total_output_tokens)}</td>
                  ))}
                </tr>
                <tr>
                  <td className="metric-label">Cache Hit Tokens</td>
                  {compareRuns.map((r) => (
                    <td key={r.run_id}>{formatTokens(r.summary?.total_cache_tokens)}</td>
                  ))}
                </tr>
              </tbody>
            </table>
          </div>
          )}
        </div>
      </section>

      <ScoreComparison runs={compareRuns} cases={cases} />

      {/* Part 2: Bottom Side-by-Side Execution Trace */}
      <section className="comparison-bottom-section">
        <div className="section-title-bar">
          <span className="kicker">PARALLEL EXECUTION FLOW</span>
          <h3>Side-by-Side Step Traces</h3>
        </div>

        <div className={`comparison-traces-grid cols-${compareRuns.length}`}>
          {compareRuns.map((run) => {
            const caseName = cases.find((c) => c.id === run.case_id)?.name || run.case_id
            return (
              <ComparisonColumn key={run.run_id} run={run} caseName={caseName} api={api} />
            )
          })}
        </div>
      </section>
    </div>
  )
}

createRoot(document.getElementById('root')!).render(<App />)
