import { CheckCircle2, FlaskConical, XCircle } from 'lucide-react'
import type { ReactNode } from 'react'
import { LiveChart } from '../components/LiveChart'
import { CompareBar, EmptyNote, ErrorBlock, LoadingBlock, PageHeader, Panel, PanelHeader, ProvenanceBadge, cx } from '../components/ui'
import type { Tick } from '../lib/api'
import { useJson } from '../lib/loadData'

type Auc = { auc: number; ci_low: number; ci_high: number; n?: number; prevalence?: number }
type Rho = { rho: number; ci_low: number; ci_high: number }
type Onset = { n_onsets: number; detected: number; delays_h: Array<number | null>; median_delay_h: number | null; n_alarms: number; false_alarms: number }
type Episode = { n_alarms: number; precision: number | null; precision_ci: [number, number]; recall: number | null; recall_ci: [number, number]; median_delay_bins: number | null }
type Power = { swarm_share: number; evasive: boolean; seeds: number; detection_rate: number; detection_ci: [number, number]; median_delay_bins: number | null; false_alarms_before_onset_per_1000_bins: number }

type Backtests = {
  updated_at?: string
  moltbook?: {
    n_posts: number
    n_agents: number
    spam_rate: number
    post_level: Record<string, Auc>
    agent_level: Record<string, Auc | number>
    bin_level: Record<string, Rho>
    alarms: Record<string, Episode | number>
    wave_campaign?: {
      prevalence: number
      label: string
      post_level: Record<string, Auc>
      agent_level: Record<string, Auc | number>
      bin_level: Record<string, Rho>
      onsets: string[]
      onset_detection: Record<string, Onset>
    }
    first_alarm_near_wave: string | null
    wave_alarm_lead_h: number | null
    intervention_feb17: { before: number; after: number; delta: number; ci_low: number; ci_high: number } | null
    null_false_alarms: { false_alarms_per_1000_bins: number; ci?: [number, number]; bound_per_1000_bins: number }
    timeline: Array<{ t: string; C: number | null; spam: number | null; n: number; log10_S: number | null; alarm: boolean }>
    timings: { events_per_s: number; engine_s: number }
    error?: string
    skipped?: string
  }
  wiki?: {
    n_revisions: number
    n_actors: number
    first_alarm: string | null
    lead_h_first_alarm_vs_21jun: number | null
    landmarks: Array<{ t: string; label: string; kind: string }>
    null_false_alarms: { false_alarms_per_1000_bins: number; bound_per_1000_bins: number } | null
    actor_level?: { n_actors: number; n_human: number; ours_coord_score: Auc | null; baseline_n_edits: Auc | null; baseline_dup_frac: Auc | null }
    timeline: Array<{ t: string; C: number | null; n: number; log10_S: number | null; alarm: boolean }>
    sensitivity?: Array<{ freq: string; min_actors: number; n_alarms: number; first_alarm: string | null }>
    error?: string
  }
  whowhen?: {
    splits: Record<
      string,
      {
        test: { agent_acc: number; agent_ci: [number, number]; step_acc: number; step_ci: [number, number]; n: number }
        baselines_on_test: Record<string, { agent_acc: number; step_acc: number }>
        weights: Record<string, number>
      }
    >
    cv5?: Record<
      string,
      {
        n: number
        agent_acc: number
        agent_ci: [number, number]
        step_acc: number
        step_ci: [number, number]
        baselines_agent_acc: Record<string, number>
      }
    >
    reference: string
    error?: string
  }
  stress?: {
    design: string
    scale: Array<{ events: number; seconds: number; events_per_s: number; frame_mb: number; detected: boolean; delay_bins: number | null; false_alarms_before_onset: number }>
    power: Power[]
    evasion: Power[]
    null: { false_alarms: number; bins: number; per_1000_bins: number; bound_per_1000_bins: number }
    fuzz: { rounds: number; failures: number }
    ablation_per_bin_prefix_only?: { power: Power[]; evasion: Power[]; null: { per_1000_bins: number } }
  }
}

const f = (v: number | null | undefined, d = 3) => (v == null ? '—' : v.toFixed(d))
const ci = (a?: Auc | null) => (a ? `${a.auc.toFixed(3)} [${a.ci_low.toFixed(3)}, ${a.ci_high.toFixed(3)}]` : '—')

function Verdict({ ok, children }: { ok: boolean | null; children: ReactNode }) {
  const Icon = ok == null ? FlaskConical : ok ? CheckCircle2 : XCircle
  return (
    <div className={cx('flex items-start gap-2 rounded-lg border px-3 py-2 text-[12.5px]', ok == null ? 'border-line' : ok ? 'border-good/35 bg-good/5' : 'border-serious/35 bg-serious/5')}>
      <Icon size={15} className={cx('mt-0.5 shrink-0', ok == null ? 'text-muted' : ok ? 'text-[#4cc94c]' : 'text-serious')} />
      <div className="text-fg-2">{children}</div>
    </div>
  )
}

function AucRow({ label, ours, base, baseName }: { label: string; ours?: Auc | null; base?: Auc | null; baseName: string }) {
  if (!ours) return null
  return (
    <div className="grid grid-cols-[140px_1fr_200px] items-center gap-3 border-t border-line py-2 text-[12px]">
      <div className="text-fg-2">{label}</div>
      <CompareBar value={ours.auc} lo={ours.ci_low} hi={ours.ci_high} baseline={base?.auc} domain={[0.3, 1]} />
      <div className="mono text-[11px] text-muted">
        <span className="text-fg">{ci(ours)}</span>
        <br />
        {baseName} {base ? base.auc.toFixed(3) : '—'}
      </div>
    </div>
  )
}

function PowerChart({ rows, old }: { rows: Power[]; old?: Power[] }) {
  const w = 520
  const h = 170
  const m = { l: 36, r: 10, t: 10, b: 26 }
  const xs = rows.map((r) => r.swarm_share)
  const x0 = Math.log10(Math.min(...xs) * 0.8)
  const x1 = Math.log10(Math.max(...xs) * 1.2)
  const X = (v: number) => m.l + ((Math.log10(v) - x0) / (x1 - x0)) * (w - m.l - m.r)
  const Y = (v: number) => m.t + (1 - v) * (h - m.t - m.b)
  const line = (rs: Power[]) => rs.map((r, i) => `${i ? 'L' : 'M'}${X(r.swarm_share)},${Y(r.detection_rate)}`).join('')
  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="w-full">
      {[0, 0.5, 1].map((v) => (
        <g key={v}>
          <line x1={m.l} x2={w - m.r} y1={Y(v)} y2={Y(v)} stroke="#1c2330" />
          <text x={m.l - 6} y={Y(v) + 3} textAnchor="end" fontSize={10} className="mono" fill="#4c5666">
            {v}
          </text>
        </g>
      ))}
      {rows.map((r) => (
        <g key={r.swarm_share}>
          <text x={X(r.swarm_share)} y={h - 8} textAnchor="middle" fontSize={10} className="mono" fill="#4c5666">
            {(r.swarm_share * 100).toFixed(1)}%
          </text>
          <line x1={X(r.swarm_share)} x2={X(r.swarm_share)} y1={Y(r.detection_ci[0])} y2={Y(r.detection_ci[1])} stroke="#6aa8ff" strokeWidth={6} opacity={0.25} />
        </g>
      ))}
      {old && <path d={line(old)} fill="none" stroke="#7d8899" strokeDasharray="4 3" strokeWidth={1.5} />}
      <path d={line(rows)} fill="none" stroke="#6aa8ff" strokeWidth={2} />
      {rows.map((r) => (
        <circle key={r.swarm_share} cx={X(r.swarm_share)} cy={Y(r.detection_rate)} r={3.5} fill="#6aa8ff" />
      ))}
    </svg>
  )
}

export function BacktestsView() {
  const bt = useJson<Backtests>('backtests.json')
  if (bt.status === 'loading') return <LoadingBlock />
  if (bt.status === 'error') return <ErrorBlock error={`${bt.error} — run: uv run kollude backtest && uv run kollude stress`} />
  const { moltbook: m, wiki: w, whowhen: ww, stress: s } = bt.data
  const wc = m?.wave_campaign
  const ours = (k: string) => m?.alarms?.[k] as Episode | undefined
  const onsetOurs = wc?.onset_detection?.ours_e_detector

  return (
    <div className="space-y-4">
      <PageHeader
        title="Backtests — real labelled data"
        subtitle="Every number has a named baseline and a 95% interval. Labels are the datasets' own (platform flags, protocol markers, archive handle tables, ICML annotations) — never ours."
        right={<span className="mono text-[11px] text-muted">updated {bt.data.updated_at?.slice(0, 16).replace('T', ' ')}</span>}
      />

      {m && !m.error && !m.skipped && (
        <Panel>
          <PanelHeader
            eyebrow="Moltbook · AI-agent social network · Jan 27 – Feb 28 2026"
            title={`${m.n_posts.toLocaleString()} posts · ${m.n_agents.toLocaleString()} agents · scanned at ${Math.round(m.timings.events_per_s).toLocaleString()} posts/s`}
            right={<ProvenanceBadge kind="measured" />}
          />
          <div className="grid gap-3 lg:grid-cols-3">
            {onsetOurs && (
              <Verdict ok={onsetOurs.detected === onsetOurs.n_onsets}>
                <b className="text-fg">Bot-wave onsets caught {onsetOurs.detected}/{onsetOurs.n_onsets}</b> — delays {onsetOurs.delays_h.map((d) => (d == null ? 'miss' : `${d}h`)).join(', ')} ·{' '}
                {onsetOurs.false_alarms} alarms outside onset windows (volume z-score: {wc?.onset_detection?.baseline_volume_z3?.false_alarms}, exact-dup:{' '}
                {wc?.onset_detection?.baseline_dup_share_z3?.false_alarms}).
              </Verdict>
            )}
            {m.intervention_feb17 && (
              <Verdict ok={m.intervention_feb17.ci_low > 0}>
                <b className="text-fg">Feb 17 enforcement measured</b>: coordinated share {f(m.intervention_feb17.before)} → {f(m.intervention_feb17.after)} (Δ {f(m.intervention_feb17.delta)} [
                {f(m.intervention_feb17.ci_low)}, {f(m.intervention_feb17.ci_high)}]).
              </Verdict>
            )}
            <Verdict ok={m.null_false_alarms.false_alarms_per_1000_bins <= m.null_false_alarms.bound_per_1000_bins}>
              <b className="text-fg">Calibrated</b>: {f(m.null_false_alarms.false_alarms_per_1000_bins, 2)} false alarms / 1000 bins on time-shuffled nulls (guarantee ≤{' '}
              {m.null_false_alarms.bound_per_1000_bins}).
            </Verdict>
          </div>

          <div className="mt-4">
            <LiveChart
              ticks={m.timeline.map((t) => ({ t: t.t, n: t.n, actors: 0, C: t.C, M: null, coord: 0, p: null, log10_S: t.log10_S, alarm: t.alarm, label_rate: t.spam }) as Tick)}
              alpha={0.01}
              landmarks={[
                { t: '2026-02-06T00:00:00Z', label: 'mbc-20 wave', kind: 'ground_truth' },
                { t: '2026-02-17T00:00:00Z', label: 'enforcement', kind: 'intervention' },
              ]}
              height={260}
            />
          </div>

          {wc && (
            <div className="mt-4 grid gap-4 lg:grid-cols-2">
              <div>
                <div className="mono mb-1 text-[10.5px] uppercase tracking-[0.14em] text-muted">Campaign label — mbc-20 protocol marker (unseen by the engine), prevalence {f(wc.prevalence, 2)}</div>
                <AucRow label="Post AUROC" ours={wc.post_level.ours_template_cluster} base={wc.post_level.baseline_exact_duplicate} baseName="exact-dup" />
                <AucRow label="Agent AUROC" ours={wc.agent_level.ours_coord_score as Auc} base={wc.agent_level.baseline_dup_frac as Auc} baseName="dup-frac" />
                <div className="mono border-t border-line py-2 text-[11.5px] text-muted">
                  Spearman(C, wave share) <span className="text-fg">{f(wc.bin_level.spearman_C_vs_wave_share?.rho)}</span> vs volume {f(wc.bin_level.spearman_volume_vs_wave_share?.rho)}
                </div>
              </div>
              <div>
                <div className="mono mb-1 text-[10.5px] uppercase tracking-[0.14em] text-muted">Platform `is_spam` flag (noisy — reported as-is), prevalence {f(m.spam_rate, 2)}</div>
                <AucRow label="Post AUROC" ours={m.post_level.ours_template_cluster} base={m.post_level.baseline_exact_duplicate} baseName="exact-dup" />
                <AucRow label="Agent AUROC" ours={m.agent_level.ours_coord_score as Auc} base={m.agent_level.baseline_dup_frac as Auc} baseName="dup-frac" />
                <div className="mono border-t border-line py-2 text-[11.5px] text-muted">
                  Alarm precision vs spam surges: <span className="text-fg">{f(ours('ours_e_detector')?.precision, 2)}</span> · volume {f(ours('baseline_volume_z3')?.precision, 2)} · exact-dup{' '}
                  {f(ours('baseline_dup_share_z3')?.precision, 2)}
                </div>
              </div>
            </div>
          )}
          <div className="mt-3 text-[11.5px] leading-snug text-faint">
            Why two labels: 68% of posts are mbc-20 mint inscriptions, yet only 19% of them carry `is_spam` (vs 11% of other posts), and the flag collapses from ~27% to ~4% on Feb 14 while the wave
            continues — a classifier change, not a behaviour change. We report both.
          </div>
        </Panel>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        {w && !w.error && (
          <Panel>
            <PanelHeader eyebrow="collusion.wiki · 2026 agent-swarm incident" title={`${w.n_revisions.toLocaleString()} revisions · ${w.n_actors} handles`} right={<ProvenanceBadge kind="measured" />} />
            <LiveChart
              ticks={w.timeline.map((t) => ({ t: t.t, n: t.n, actors: 0, C: t.C, M: null, coord: 0, p: null, log10_S: t.log10_S, alarm: t.alarm, label_rate: null }) as Tick)}
              alpha={0.01}
              landmarks={w.landmarks}
              height={220}
              showLabel={false}
            />
            <div className="mt-3 space-y-2">
              <Verdict ok={w.lead_h_first_alarm_vs_21jun != null && w.lead_h_first_alarm_vs_21jun > 0}>
                First alarm <b className="text-fg">{w.first_alarm?.slice(0, 16).replace('T', ' ') ?? 'none'}</b>
                {w.lead_h_first_alarm_vs_21jun != null && ` — ${(w.lead_h_first_alarm_vs_21jun / 24).toFixed(1)} days before humans traced OpenAI-HQ IPs (21 Jun)`}.
              </Verdict>
              {w.actor_level?.ours_coord_score && (
                <Verdict ok={null}>
                  Agent vs human handle AUROC <b className="text-fg">{ci(w.actor_level.ours_coord_score)}</b> · edit-count baseline {f(w.actor_level.baseline_n_edits?.auc)} — not a headline (n={w.actor_level.n_actors}, humans=
                  {w.actor_level.n_human}).
                </Verdict>
              )}
              {w.sensitivity && (
                <div className="mono text-[11px] leading-relaxed text-faint">
                  Sensitivity (alarms):{' '}
                  {w.sensitivity.map((g) => `${g.freq}/≥${g.min_actors} → ${g.n_alarms}`).join(' · ')}. Coarser bins stay quiet; the headline is 1h and min_actors 5.
                </div>
              )}
            </div>
          </Panel>
        )}

        {ww && !ww.error && (
          <Panel>
            <PanelHeader eyebrow="Who&When · ICML 2025 · failure attribution" title="Which agent / step broke the run? (no LLM)" right={<ProvenanceBadge kind="measured" />} />
            {ww.cv5 && (
              <table className="mb-3 w-full text-left text-[12px]">
                <thead className="mono text-[10px] uppercase tracking-wider text-faint">
                  <tr>
                    <th className="py-1">5-fold CV</th>
                    <th>agent acc</th>
                    <th>random</th>
                    <th>last agent</th>
                    <th>train prior</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(ww.cv5).map(([k, v]) => (
                    <tr key={k} className="border-t border-line">
                      <td className="mono py-2 text-fg-2">
                        {k} <span className="text-faint">n={v.n}</span>
                      </td>
                      <td className="mono text-fg">
                        {f(v.agent_acc)} <span className="text-faint">[{f(v.agent_ci[0], 2)}, {f(v.agent_ci[1], 2)}]</span>
                      </td>
                      <td className="mono text-muted">{f(v.baselines_agent_acc.random)}</td>
                      <td className="mono text-muted">{f(v.baselines_agent_acc.last_agent)}</td>
                      <td className="mono text-muted">{f(v.baselines_agent_acc.train_prior)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            <div className="mono mb-1 text-[10px] uppercase tracking-wider text-faint">cross-domain transfer</div>
            <table className="w-full text-left text-[12px]">
              <thead className="mono text-[10px] uppercase tracking-wider text-faint">
                <tr>
                  <th className="py-1">train → test</th>
                  <th>agent acc</th>
                  <th>step acc</th>
                  <th>random</th>
                  <th>last agent</th>
                </tr>
              </thead>
              <tbody>
                {Object.entries(ww.splits).map(([k, v]) => (
                  <tr key={k} className="border-t border-line">
                    <td className="mono py-2 text-fg-2">{k.replace('train_', '').replace('_test_', ' → ')}</td>
                    <td className="mono text-fg">
                      {f(v.test.agent_acc)} <span className="text-faint">[{f(v.test.agent_ci[0], 2)}, {f(v.test.agent_ci[1], 2)}]</span>
                    </td>
                    <td className="mono text-fg">{f(v.test.step_acc)}</td>
                    <td className="mono text-muted">{f(v.baselines_on_test.random?.agent_acc)}</td>
                    <td className="mono text-muted">{f(v.baselines_on_test.last_agent?.agent_acc)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="mt-3 text-[11.5px] text-faint">{ww.reference}</div>
          </Panel>
        )}
      </div>

      {s ? (
        <Panel>
          <PanelHeader eyebrow="stress · exact ground truth" title="Scale, detection power, evasion, fuzzing" right={<ProvenanceBadge kind="synthetic" />} />
          <div className="grid gap-4 lg:grid-cols-2">
            <div>
              <div className="mono mb-1 text-[10.5px] uppercase tracking-[0.14em] text-muted">detection rate vs swarm share · solid = v0.3 engine · dashed = per-bin prefix-only ablation</div>
              <PowerChart rows={s.power} old={s.ablation_per_bin_prefix_only?.power} />
              <div className="mt-2 space-y-1 text-[11.5px] text-muted">
                {s.evasion.map((r) => (
                  <div key={r.swarm_share}>
                    Evasive swarm (random lead words) at {(r.swarm_share * 100).toFixed(0)}%: <span className="text-fg">{f(r.detection_rate, 2)}</span>
                    {s.ablation_per_bin_prefix_only && ` (ablation ${f(s.ablation_per_bin_prefix_only.evasion.find((o) => o.swarm_share === r.swarm_share)?.detection_rate, 2)})`}
                  </div>
                ))}
                <div>
                  No-swarm null: {s.null.false_alarms} alarms / {s.null.bins} bins = <span className="text-fg">{f(s.null.per_1000_bins, 2)}</span> per 1000 (bound {s.null.bound_per_1000_bins})
                </div>
                <div>
                  Fuzz: <span className="text-fg">{s.fuzz.rounds - s.fuzz.failures}/{s.fuzz.rounds}</span> hostile-input rounds passed
                </div>
              </div>
            </div>
            <div>
              <table className="w-full text-left text-[12px]">
                <thead className="mono text-[10px] uppercase tracking-wider text-faint">
                  <tr>
                    <th className="py-1">events</th>
                    <th>scan s</th>
                    <th>events/s</th>
                    <th>MB</th>
                    <th>swarm caught</th>
                  </tr>
                </thead>
                <tbody>
                  {s.scale.map((r) => (
                    <tr key={r.events} className="border-t border-line">
                      <td className="mono py-1.5 text-fg">{r.events.toLocaleString()}</td>
                      <td className="mono text-fg-2">{r.seconds.toFixed(1)}</td>
                      <td className="mono text-fg-2">{Math.round(r.events_per_s).toLocaleString()}</td>
                      <td className="mono text-muted">{r.frame_mb.toFixed(0)}</td>
                      <td className="mono">{r.detected ? <span className="text-[#4cc94c]">+{r.delay_bins} bins</span> : <span className="text-serious">missed</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="mt-3 text-[11.5px] leading-snug text-faint">{s.design}</div>
            </div>
          </div>
        </Panel>
      ) : (
        <EmptyNote>Stress results pending — run `uv run kollude stress`.</EmptyNote>
      )}
    </div>
  )
}
