import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useSession } from '../App';
import { api, downloadJson, message, Settings } from '../lib/api';
import { Button, Confirm, Spinner, Toggle, useToast } from '../components/ui';

const THRESHOLDS: { key: string; label: string; help: string; min: number; max: number; step: number }[] = [
  { key: 's_xcorr', label: 'Pattern match', help: 'Best correlation with the target pattern', min: 0, max: 1, step: 0.01 },
  { key: 's_phase', label: 'Inhale and exhale timing', help: 'Share of phases moving the right way', min: 0, max: 1, step: 0.01 },
  { key: 's_live', label: 'Live pulse present', help: 'Share of the window with a confident reading', min: 0, max: 1, step: 0.01 },
  { key: 's_decoy', label: 'Margin over decoys', help: 'Target match minus the best decoy match', min: -1, max: 1, step: 0.01 },
  { key: 's_coupling', label: 'Pulse follows pattern', help: 'Only used if the gate below is turned on', min: 0, max: 1, step: 0.01 },
  { key: 'pulse_confidence_min', label: 'Pulse confidence floor', help: 'SDK confidence, 0 to 100', min: 0, max: 100, step: 1 },
];
const GATES: { key: string; label: string }[] = [
  { key: 'xcorr', label: 'Pattern match' }, { key: 'phase', label: 'Inhale and exhale timing' }, { key: 'cycles', label: 'Number of breaths' },
  { key: 'live', label: 'Live pulse present' }, { key: 'decoy', label: 'Beats the decoys' }, { key: 'coupling', label: 'Pulse follows pattern (off until the evaluation supports it)' },
];

// One click for recording a demo: only a live pulse and a rough follow of the pacer are required.
// Timing, breath count and the decoy margin are switched off. "Reset to defaults" undoes it.
const EASY_THRESHOLDS = { s_xcorr: 0.1, s_live: 0.5 };
const EASY_GATES = { xcorr: true, live: true, phase: false, cycles: false, decoy: false, coupling: false };
const isEasy = (s: Settings) => Object.entries(EASY_GATES).every(([k, v]) => !!s.enabled_gates[k] === v) && s.thresholds.s_xcorr <= EASY_THRESHOLDS.s_xcorr;

export function SettingsPage() {
  const { me, refresh, signOut } = useSession();
  const toast = useToast();
  const navigate = useNavigate();
  const [s, setS] = useState<Settings | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [consent, setConsent] = useState<string[]>([]);
  const [askDelete, setAskDelete] = useState(false);
  const [askLlm, setAskLlm] = useState(false);

  const adopt = useCallback((next: Settings) => {
    setS(next);
    setValues(Object.fromEntries(Object.entries(next.thresholds).map(([k, v]) => [k, String(v)])));
  }, []);

  const load = useCallback(async () => {
    try {
      adopt(await api.get<Settings>('/api/settings'));
      setConsent((await api.get<{ active: string[] }>('/api/consent')).active);
    } catch (err) {
      toast(message(err), 'error');
    }
  }, [adopt, toast]);

  useEffect(() => {
    load();
  }, [load]);

  const patch = async (body: Partial<Settings>, done = 'Saved') => {
    try {
      adopt(await api.put<Settings>('/api/settings', body));
      await refresh();
      toast(done);
    } catch (err) {
      toast(message(err), 'error');
    }
  };

  const saveThresholds = async () => {
    const parsed: Record<string, number> = {};
    for (const t of THRESHOLDS) {
      const n = Number(values[t.key]);
      if (values[t.key] === '' || Number.isNaN(n) || n < t.min || n > t.max) {
        toast(`${t.label} must be between ${t.min} and ${t.max}.`, 'error');
        return;
      }
      parsed[t.key] = n;
    }
    await patch({ thresholds: parsed }, 'Thresholds saved');
  };

  const reset = async () => {
    try {
      adopt(await api.post<Settings>('/api/settings/reset-thresholds'));
      toast('Reset to defaults');
    } catch (err) {
      toast(message(err), 'error');
    }
  };

  const easy = async () => {
    await patch({ thresholds: { ...s!.thresholds, ...EASY_THRESHOLDS }, enabled_gates: EASY_GATES }, 'Easy demo on: a live pulse and a rough follow of the pacer will pass');
  };

  const enableLlm = async () => {
    try {
      await api.post('/api/consent', { scope: 'runtime_llm' });
      adopt(await api.put<Settings>('/api/settings', { runtime_llm_enabled: true }));
      await refresh();
      setConsent((c) => [...new Set([...c, 'runtime_llm'])]);
      setAskLlm(false);
      toast('Plain-language explanations are on');
    } catch (err) {
      toast(message(err), 'error');
    }
  };

  const disableLlm = async () => {
    try {
      await api.del('/api/consent?scope=runtime_llm');
      await load();
      await refresh();
      toast('Plain-language explanations are off');
    } catch (err) {
      toast(message(err), 'error');
    }
  };

  const revoke = async (scope: string, label: string) => {
    try {
      await api.del(`/api/consent?scope=${scope}`);
      await load();
      await refresh();
      toast(`${label} consent withdrawn`);
      if (scope === 'gate') navigate('/onboarding');
    } catch (err) {
      toast(message(err), 'error');
    }
  };

  const grantEvaluation = async () => {
    try {
      await api.post('/api/consent', { scope: 'evaluation' });
      await load();
      await refresh();
      toast('Evaluation mode allowed');
    } catch (err) {
      toast(message(err), 'error');
    }
  };

  const deleteAll = async () => {
    try {
      await api.del('/api/data');
      setAskDelete(false);
      await refresh();
      toast('All data deleted');
      navigate('/onboarding');
    } catch (err) {
      toast(message(err), 'error');
    }
  };

  if (!s) return <Spinner />;

  return (
    <main className="page narrow">
      <h1>Settings</h1>

      <section className="card">
        <div className="row between wrap">
          <h2>Thresholds</h2>
          <span className="row">
            {isEasy(s) && <span className="pill warn" data-testid="easy-label">Easy demo</span>}
            <span className={`pill ${s.thresholds_calibrated ? 'live' : 'sim'}`} data-testid="threshold-label">{s.thresholds_calibrated ? 'Calibrated' : 'Provisional'}</span>
          </span>
        </div>
        <div className="easy-demo row between wrap">
          <p className="small">Recording a demo? <strong>Easy demo</strong> passes any check with a live pulse and a rough follow of the pacer. Timing, breath count and decoys are switched off. Reset to defaults turns it off.</p>
          <Button className="btn primary" onAct={easy} busyLabel="Applying…" data-testid="easy-demo">Easy demo</Button>
        </div>
        <p className="muted small">{s.thresholds_calibrated ? 'Set from the calibration split of live evaluation trials. Editing one makes them provisional again.' : 'Defaults that have not been calibrated on live trials yet.'}</p>
        <div className="threshold-grid">
          {THRESHOLDS.map((t) => (
            <label key={t.key} title={t.help}>
              {t.label}
              <input type="number" min={t.min} max={t.max} step={t.step} value={values[t.key] ?? ''} onChange={(e) => setValues({ ...values, [t.key]: e.target.value })} data-testid={`th-${t.key}`} />
              <small className="muted">{t.help}</small>
            </label>
          ))}
        </div>
        <div className="row end">
          <Button className="btn" onAct={reset} data-testid="reset-thresholds">Reset to defaults</Button>
          <Button className="btn primary" onAct={saveThresholds} busyLabel="Saving…" data-testid="save-thresholds">Save thresholds</Button>
        </div>
        <h3>Enabled gates</h3>
        <div className="stack">
          {GATES.map((g) => (
            <Toggle key={g.key} checked={!!s.enabled_gates[g.key]} onChange={(next) => patch({ enabled_gates: { [g.key]: next } }, `${g.label}: ${next ? 'on' : 'off'}`)} label={g.label} testid={`gate-${g.key}`} />
          ))}
        </div>
      </section>

      <section className="card">
        <h2>Sensor</h2>
        <p className="muted small">Trace sign: {s.breath_polarity === null ? 'not calibrated yet' : s.breath_polarity > 0 ? 'inhale rises' : 'inhale falls'}.</p>
        <div className="row wrap">
          <Button className="btn" onAct={() => patch({ breath_polarity: 1 }, 'Inhale rises')} data-testid="polarity-up">Inhale rises</Button>
          <Button className="btn" onAct={() => patch({ breath_polarity: -1 }, 'Inhale falls')} data-testid="polarity-down">Inhale falls</Button>
          <Button className="btn" onAct={() => navigate('/onboarding')} data-testid="recalibrate">Calibrate again</Button>
        </div>
      </section>

      <section className="card">
        <h2>Privacy</h2>
        <div className="stack">
          <Toggle checked={!s.telemetry_opt_out} onChange={(next) => patch({ telemetry_opt_out: !next })} label="Share SDK telemetry" description={<>One aggregate per-session summary, never video, measured values or identifiers. Off sets <code>enableTelemetry: false</code>.</>} testid="telemetry" />
          <Toggle checked={s.store_command_text} onChange={(next) => patch({ store_command_text: next })} label="Store command text" description="Off keeps only the SHA-256 hash. While a check is pending the text stays in server memory so the window can show it." testid="store-text" />
          <Toggle checked={s.runtime_llm_enabled} onChange={(next) => (next ? setAskLlm(true) : disableLlm())} disabled={!s.runtime_llm_available} label="Plain-language explanations (NanoGPT)" description={s.runtime_llm_available ? "Sends a gated command's text to NanoGPT when you ask for an explanation. Never used for the decision." : 'Not configured on this server.'} testid="runtime-llm" />
        </div>
        <h3>Consent</h3>
        <ul className="plain small" data-testid="consent-list">
          <li className="row between wrap">
            <span>Breath checks: {consent.includes('gate') ? 'accepted' : 'not accepted'}</span>
            {consent.includes('gate') && <Button className="link bad" onAct={() => revoke('gate', 'Breath check')} data-testid="revoke-gate">Withdraw</Button>}
          </li>
          <li className="row between wrap">
            <span>Evaluation mode: {consent.includes('evaluation') ? 'accepted' : 'not accepted'}</span>
            {consent.includes('evaluation')
              ? <Button className="link bad" onAct={() => revoke('evaluation', 'Evaluation')} data-testid="revoke-eval">Withdraw</Button>
              : <Button className="link" onAct={grantEvaluation} data-testid="grant-eval">Allow</Button>}
          </li>
        </ul>
      </section>

      <section className="card">
        <h2>Your data</h2>
        <p className="muted small">Receipts stay until you delete them. {me?.role === 'jury' && 'This sandbox is removed automatically after 7 days without use.'}</p>
        <div className="row wrap">
          <Button className="btn" onAct={async () => { try { await downloadJson('/api/receipts/export', 'pob-receipts.json'); toast('Export downloaded'); } catch (err) { toast(message(err), 'error'); } }} busyLabel="Exporting…" data-testid="settings-export">Export receipts (JSON)</Button>
          <button type="button" className="btn danger" onClick={() => setAskDelete(true)} data-testid="delete-all">Delete all data</button>
          <Button className="btn" onAct={async () => { await signOut(); navigate('/login'); }} data-testid="settings-signout">Sign out</Button>
        </div>
      </section>

      {askDelete && (
        <Confirm title="Delete all data?" body="This removes every receipt, consent record, custom rule and evaluation trial in this workspace and returns it to first-run defaults. It cannot be undone." confirmLabel="Delete everything" onConfirm={deleteAll} onCancel={() => setAskDelete(false)} />
      )}
      {askLlm && (
        <Confirm title="Turn on plain-language explanations?" body="When you press Explain, the gated command's text is sent to NanoGPT, an outside AI service. Commands can contain sensitive names. It is never used for the gating decision." confirmLabel="I agree, turn on" onConfirm={enableLlm} onCancel={() => setAskLlm(false)} />
      )}
    </main>
  );
}
