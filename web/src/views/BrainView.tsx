import { useMemo, useState } from 'react'
import {
  ErrorBlock,
  LegendSwatch,
  LoadingBlock,
  PageHeader,
  Panel,
  PanelHeader,
  ProvenanceBadge,
  cx,
} from '../components/ui'
import { INK, misguidanceColor } from '../lib/colors'
import { fmtNum } from '../lib/format'
import { useJson } from '../lib/loadData'
import type { WhiteboxData } from '../types'

export function BrainView() {
  const wb = useJson<WhiteboxData>('whitebox_ep001.json')
  if (wb.status === 'error') return <ErrorBlock error={wb.error} />
  if (wb.status === 'loading') return <LoadingBlock label="Loading whitebox probe" />
  return <BrainInner data={wb.data} />
}

function BrainInner({ data }: { data: WhiteboxData }) {
  const [tokenIdx, setTokenIdx] = useState(
    Math.min(data.highlight_token_range[0] + 2, data.token_text.length - 1),
  )

  const layers = data.scores.length
  const tokens = data.scores[0]?.length ?? 0
  const cellW = 18
  const cellH = 14
  const left = 36
  const top = 10

  const maxPerToken = useMemo(
    () =>
      Array.from({ length: tokens }, (_, ti) =>
        Math.max(0, ...data.scores.map((row) => row[ti] ?? 0)),
      ),
    [data.scores, tokens],
  )

  const red = data.thresholds?.red ?? 0.65
  const amber = data.thresholds?.amber ?? 0.45
  const writeAt = data.highlight_token_range[1]
  const colScores = data.scores.map((row) => row[tokenIdx] ?? 0)

  const sparkH = 72
  const sparkW = tokens * cellW
  const yOf = (s: number) => sparkH - 8 - s * (sparkH - 20)

  return (
    <div>
      <PageHeader
        title="Brain"
        subtitle="Layer × token misguidance heatmap for the peer_adoption probe. Activations are synthesized from FORGE labels — not a real forward pass."
        right={<ProvenanceBadge kind="synthetic" />}
      />

      <div className="mb-3 flex flex-wrap items-center gap-3">
        <span className="mono text-[11.5px] text-muted">
          {data.agent_id} · probe {data.probe} · {layers} layers × {tokens} tokens
        </span>
        <LegendSwatch color={misguidanceColor(0.2)} label="low" />
        <LegendSwatch color={misguidanceColor(0.55)} label="amber" />
        <LegendSwatch color={misguidanceColor(0.9)} label="red / misguidance" />
        <LegendSwatch color="#ff5a5a" shape="line" label="write marker" />
      </div>

      <div className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_280px]">
        <div className="space-y-3">
          <Panel>
            <PanelHeader
              eyebrow="Misguidance grid"
              title={data.note}
              right={<span className="mono text-[10px] text-muted">click a column</span>}
            />
            <div className="overflow-auto scroll-thin">
              <svg width={left + tokens * cellW + 8} height={top + layers * cellH + 8} className="block">
                {/* write column highlight */}
                <rect
                  x={left + writeAt * cellW - 1}
                  y={top - 2}
                  width={cellW}
                  height={layers * cellH + 4}
                  fill="#ff5a5a18"
                  stroke="#ff5a5a44"
                  strokeWidth={1}
                />
                {data.scores.map((row, li) =>
                  row.map((s, ti) => {
                    const active = ti === tokenIdx
                    return (
                      <rect
                        key={`${li}-${ti}`}
                        x={left + ti * cellW}
                        y={top + li * cellH}
                        width={cellW - 1.5}
                        height={cellH - 1.5}
                        rx={1.5}
                        fill={misguidanceColor(s)}
                        stroke={active ? '#e8edf4' : 'transparent'}
                        strokeWidth={active ? 1.2 : 0}
                        style={{ cursor: 'pointer' }}
                        onClick={() => setTokenIdx(ti)}
                      >
                        <title>
                          L{li} · T{ti} · {fmtNum(s, 3)}
                        </title>
                      </rect>
                    )
                  }),
                )}
                {Array.from({ length: layers }, (_, i) => (
                  <text
                    key={i}
                    x={4}
                    y={top + i * cellH + 10}
                    fill={INK.faint}
                    fontSize={9}
                    fontFamily="JetBrains Mono, monospace"
                  >
                    L{i}
                  </text>
                ))}
              </svg>
            </div>
          </Panel>

          <Panel>
            <PanelHeader
              eyebrow="Per-token max score"
              title="Sparkline across the sequence"
              right={
                <span className="mono text-[10.5px] text-muted">
                  threshold red={fmtNum(red)} · write @ T{writeAt}
                </span>
              }
            />
            <div className="overflow-x-auto">
              <svg width={Math.max(sparkW, 200)} height={sparkH + 28} className="block">
                <line
                  x1={0}
                  x2={sparkW}
                  y1={yOf(red)}
                  y2={yOf(red)}
                  stroke="#ff5a5a"
                  strokeWidth={1}
                  strokeDasharray="4 3"
                  opacity={0.7}
                />
                <line
                  x1={0}
                  x2={sparkW}
                  y1={yOf(amber)}
                  y2={yOf(amber)}
                  stroke="#fab219"
                  strokeWidth={1}
                  strokeDasharray="3 3"
                  opacity={0.5}
                />
                <polyline
                  fill="none"
                  stroke="#6aa8ff"
                  strokeWidth={1.6}
                  points={maxPerToken.map((s, i) => `${i * cellW + cellW / 2},${yOf(s)}`).join(' ')}
                />
                {maxPerToken.map((s, i) => (
                  <circle
                    key={i}
                    cx={i * cellW + cellW / 2}
                    cy={yOf(s)}
                    r={i === tokenIdx ? 4 : 2.2}
                    fill={i === tokenIdx ? '#ff5a5a' : misguidanceColor(s)}
                    stroke={i === tokenIdx ? '#fff' : 'transparent'}
                    strokeWidth={1}
                    style={{ cursor: 'pointer' }}
                    onClick={() => setTokenIdx(i)}
                  />
                ))}
                {/* write marker */}
                <line
                  x1={writeAt * cellW + cellW / 2}
                  x2={writeAt * cellW + cellW / 2}
                  y1={4}
                  y2={sparkH - 4}
                  stroke="#ff5a5a"
                  strokeWidth={1.5}
                />
                <text
                  x={writeAt * cellW + cellW / 2}
                  y={sparkH + 16}
                  fill="#ff7b7b"
                  fontSize={10}
                  fontFamily="JetBrains Mono, monospace"
                  textAnchor="middle"
                >
                  write
                </text>
              </svg>
            </div>
          </Panel>

          <Panel>
            <PanelHeader eyebrow="Token strip" title="Sequence under the probe" />
            <div className="flex flex-wrap gap-1">
              {data.token_text.map((tok, i) => {
                const hi =
                  i >= data.highlight_token_range[0] && i <= data.highlight_token_range[1]
                const isWrite = i === writeAt
                return (
                  <button
                    key={i}
                    type="button"
                    onClick={() => setTokenIdx(i)}
                    className={cx(
                      'mono rounded px-1.5 py-0.5 text-[11px] transition',
                      i === tokenIdx
                        ? 'border border-[#ff5a5a] bg-[#ff5a5a22] text-[#ff7b7b]'
                        : hi
                          ? 'border border-[#ff5a5a33] bg-[#ff5a5a10] text-fg'
                          : 'border border-line bg-panel-2 text-muted hover:text-fg',
                    )}
                  >
                    {isWrite ? `▸${tok}` : tok}
                  </button>
                )
              })}
            </div>
          </Panel>
        </div>

        {/* Layered node column */}
        <Panel>
          <PanelHeader
            eyebrow="Layer column"
            title={
              <span>
                token[{tokenIdx}]{' '}
                <span className="font-normal text-muted">“{data.token_text[tokenIdx]}”</span>
              </span>
            }
          />
          <div className="mono mb-3 text-[11px] text-muted">
            max {fmtNum(Math.max(...colScores), 3)} · red ≥ {fmtNum(red)}
          </div>
          <div className="flex flex-col gap-1.5">
            {colScores.map((s, li) => {
              const hot = s >= red
              const warm = s >= amber
              return (
                <div key={li} className="flex items-center gap-2">
                  <span className="mono w-6 text-[10px] text-faint">L{li}</span>
                  <div className="relative h-7 flex-1 overflow-hidden rounded-md border border-line bg-void">
                    <div
                      className="absolute inset-y-0 left-0 transition-all"
                      style={{
                        width: `${Math.max(4, s * 100)}%`,
                        background: misguidanceColor(s),
                        boxShadow: hot ? '0 0 14px #ff5a5a88' : warm ? '0 0 8px #fab21944' : 'none',
                      }}
                    />
                    {hot && (
                      <div className="absolute inset-0 animate-pulse-ring rounded-md border border-[#ff5a5a55]" />
                    )}
                  </div>
                  <span className="mono w-10 text-right text-[11px] text-fg-2">{fmtNum(s, 2)}</span>
                </div>
              )
            })}
          </div>
          <p className="mt-4 text-[12px] leading-relaxed text-muted">
            Layers that glow red exceed the probe threshold on this token — the “write happens here”
            marker sits at T{writeAt} in the highlight window [{data.highlight_token_range.join(', ')}].
          </p>
        </Panel>
      </div>
    </div>
  )
}
