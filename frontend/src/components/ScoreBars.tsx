import { Scores } from '../lib/api';

interface Row { key: string; label: string; help: string; value: number; threshold: number; min: number; max: number; gated: boolean; pass: boolean; format?: (v: number) => string }

export function buildRows(scores: Scores, thresholds: Record<string, number>, gates: Record<string, boolean>): Row[] {
  const t = (k: string, fallback: number) => thresholds?.[k] ?? fallback;
  return [
    { key: 'xcorr', label: 'Pattern match', help: 'How closely the breathing followed this pattern', value: scores.s_xcorr, threshold: t('s_xcorr', 0.6), min: 0, max: 1, gated: gates?.xcorr !== false, pass: scores.s_xcorr >= t('s_xcorr', 0.6) },
    { key: 'phase', label: 'Inhale and exhale timing', help: 'Share of phases moving in the right direction', value: scores.s_phase, threshold: t('s_phase', 0.8), min: 0, max: 1, gated: gates?.phase !== false, pass: scores.s_phase >= t('s_phase', 0.8) },
    { key: 'live', label: 'Live pulse present', help: 'Share of the window with a confident reading and a face in view', value: scores.s_live, threshold: t('s_live', 0.7), min: 0, max: 1, gated: gates?.live !== false, pass: scores.s_live >= t('s_live', 0.7) },
    { key: 'decoy', label: 'Beats the 20 decoy patterns', help: 'Match to this pattern minus the best match to any decoy', value: scores.s_decoy, threshold: t('s_decoy', 0), min: -1, max: 0.5, gated: gates?.decoy !== false, pass: scores.s_decoy >= t('s_decoy', 0) },
    { key: 'coupling', label: 'Pulse follows the pattern', help: 'Reported for research. Decoy best: ' + scores.s_coupling_decoy.toFixed(2), value: scores.s_coupling, threshold: t('s_coupling', 0.3), min: 0, max: 1, gated: gates?.coupling === true, pass: scores.s_coupling >= t('s_coupling', 0.3) },
  ];
}

export function ScoreBars({ scores, thresholds, gates }: { scores: Scores; thresholds: Record<string, number>; gates: Record<string, boolean> }) {
  const rows = buildRows(scores, thresholds, gates);
  const cyclesOk = scores.s_cycles === scores.target_cycles;
  return (
    <div className="scores" data-testid="scores">
      {rows.map((row) => {
        const scale = (v: number) => Math.max(0, Math.min(100, ((v - row.min) / (row.max - row.min)) * 100));
        return (
          <div className="score" key={row.key} title={row.help}>
            <div className="score-head">
              <span>{row.label}{!row.gated && <em> (reported only)</em>}</span>
              <span className="mono"><b className={row.gated ? (row.pass ? 'good' : 'bad') : ''}>{row.gated ? (row.pass ? '✓' : '✕') : '–'}</b> {row.value.toFixed(2)} <small>/ {row.threshold.toFixed(2)}</small></span>
            </div>
            <div className="bar">
              <div className={`bar-fill ${row.gated ? (row.pass ? 'good' : 'bad') : 'neutral'}`} style={{ width: `${scale(row.value)}%` }} />
              <div className="bar-mark" style={{ left: `${scale(row.threshold)}%` }} />
            </div>
          </div>
        );
      })}
      <div className="score">
        <div className="score-head">
          <span>Breaths detected</span>
          <span className="mono"><b className={cyclesOk ? 'good' : 'bad'}>{cyclesOk ? '✓' : '✕'}</b> {scores.s_cycles} <small>/ {scores.target_cycles}</small></span>
        </div>
      </div>
    </div>
  );
}
