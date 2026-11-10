import { FormEvent, useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useSession } from '../App';
import { api, message } from '../lib/api';
import { Button, useToast } from '../components/ui';
import { useSensorStatus } from '../lib/sensors';
import { TimeChart } from '../components/TimeChart';
import { AgentDemo, BreathField, CountUp } from '../components/Fx';

interface CaseTeaser { breath: number[][]; summary: { duration_s: number; pulse_readings: number; pulse_median_bpm: number | null }; aggregate: { n: number; passed: number } | null }

const SAMPLES = ['terraform destroy -auto-approve', 'DROP TABLE customers;', 'git push --force origin main', 'rm -rf /var/lib/app', 'kubectl delete namespace prod', 'npm test', 'git status'];

export function Home() {
  const { me } = useSession();
  const navigate = useNavigate();
  const toast = useToast();
  const [command, setCommand] = useState(SAMPLES[0]);
  const [outcome, setOutcome] = useState<{ command: string; gated: boolean } | null>(null);
  const bridge = useSensorStatus(5000);
  const [teaser, setTeaser] = useState<CaseTeaser | null>(null);
  useEffect(() => { api.get<CaseTeaser>('/api/case-study').then(setTeaser).catch(() => undefined); }, []);

  const submit = async (event?: FormEvent) => {
    event?.preventDefault();
    try {
      const out = await api.post<any>('/api/gate/requests', { command });
      if (out.gated) navigate(`/gate/${out.request_id}`);
      else setOutcome({ command, gated: false });
    } catch (err) {
      toast(message(err), 'error');
    }
  };

  const practice = async () => {
    try {
      const out = await api.post<any>('/api/gate/requests', { practice: true });
      navigate(`/gate/${out.request_id}`);
    } catch (err) {
      toast(message(err), 'error');
    }
  };

  return (
    <main className="page">
      <section className="hero">
        <div className="hero-text">
          <span className="eyebrow">An attention gate for AI agents</span>
          <h1>Routine commands pass untouched. <span className="grad">Destructive ones wait for a breath.</span></h1>
          <p className="lead">When an agent tries something it cannot undo, the command is held and a random breathing pattern appears. It runs only if a live person follows that pattern, read from a camera by the Presage SmartSpectra SDK. An agent cannot produce this, a reflex cannot satisfy it, and an old recording cannot replay it.</p>
          <div className="row wrap hero-cta">
            <Link className="btn primary big" to="/measure" data-testid="hero-measure">See your live reading</Link>
            <Button className="btn big" onAct={practice} busyLabel="Starting…" data-testid="hero-practice">Try a practice round</Button>
          </div>
          <ul className="hero-facts">
            <li><strong>New pattern</strong><span>every check</span></li>
            <li><strong>20 decoys</strong><span>it must beat</span></li>
            <li><strong>One token</strong><span>bound to one command</span></li>
          </ul>
        </div>
        <div className="hero-visual" aria-hidden="true">
          <BreathField className="hero-field" lines={14} />
          <div className="orb hero-orb"><span className="ring r1" /><span className="ring r2" /><span className="ring r3" /><span className="core" /></div>
        </div>
        <div className="hero-demo"><AgentDemo /></div>
      </section>

      {teaser && (
        <section className="card home-case" data-testid="home-case">
          <div>
            <span className="eyebrow">Case study · real SDK output</span>
            <h2>A real person, a real trace, every challenge rejected</h2>
            <p className="muted">A recorded person who never saw a pacer, read by the Presage SDK on this server, then challenged with random patterns by the real verifier.</p>
            <div className="stats">
              <div className="stat"><b><CountUp value={String(teaser.summary.pulse_readings)} /></b><span>pulse readings</span></div>
              <div className="stat"><b><CountUp value={teaser.summary.pulse_median_bpm ? String(Math.round(teaser.summary.pulse_median_bpm)) : '–'} /><small>bpm</small></b><span>median pulse</span></div>
              {teaser.aggregate && <div className="stat"><b>{teaser.aggregate.passed}/{teaser.aggregate.n}</b><span>patterns passed</span></div>}
            </div>
            <Link className="btn primary" to="/case-study" data-testid="home-case-open">Open the case study</Link>
          </div>
          <TimeChart label="One minute of the real SDK breathing trace" domain={[200, 260]} height={170} ticks={4} maxGap={1} robust
            series={[{ id: 'b', label: 'Chest trace', points: teaser.breath, color: '#5fe0c8', digits: 2 }]} />
        </section>
      )}

      <section className="card">
        <h2>Try a command</h2>
        <form onSubmit={submit} className="command-form">
          <input value={command} maxLength={2000} onChange={(e) => { setCommand(e.target.value); setOutcome(null); }} aria-label="Command" className="mono" data-testid="command-input" spellCheck={false} />
          <button type="submit" className="btn primary" disabled={!command.trim()} data-testid="command-submit">Run it through the gate</button>
        </form>
        <div className="chips" aria-label="Example commands">
          {SAMPLES.map((s) => (
            <button type="button" key={s} className="chip mono" onClick={() => { setCommand(s); setOutcome(null); }} data-testid="sample">{s}</button>
          ))}
        </div>
        {outcome && !outcome.gated && (
          <div className="note good-note" data-testid="not-gated"><strong>Passed untouched.</strong> <code>{outcome.command}</code> matched no rule, so it would run with no interruption.</div>
        )}
      </section>

      <section className="how" aria-label="How it works">
        {[
          ['explainer-agent', '1. An agent tries it', 'A hook sees the command before it runs.'],
          ['explainer-gate', '2. The gate holds it', 'Fixed rules decide. No AI is involved in this step.'],
          ['explainer-breath', '3. You follow a new pattern', 'The server compares your breathing with this pattern and 20 decoys.'],
          ['explainer-receipt', '4. A receipt is chained', 'One token for this exact command, then a tamper-evident record.'],
        ].map(([img, title, text]) => (
          <figure key={img}>
            <img src={`/art/${img}.webp`} alt="" width="512" height="512" loading="lazy" onError={(e) => { e.currentTarget.style.display = 'none'; }} />
            <figcaption><strong>{title}</strong><span className="muted small">{text}</span></figcaption>
          </figure>
        ))}
      </section>

      <div className="grid-3">
        <section className="card">
          <h3>Sensor</h3>
          <p data-testid="sensor-status" className="row wrap">
            <span className={`pill ${bridge?.camera.available ? 'live' : 'off'}`} data-testid="camera-service">{bridge?.camera.available ? 'Browser camera ready' : 'Browser camera offline'}</span>
            {me?.role === 'owner' && <span className={`pill ${bridge?.connected ? 'live' : 'off'}`}>{bridge?.connected ? `Bridge connected${bridge.sdk_version ? ` · SDK ${bridge.sdk_version}` : ''}` : 'Bridge not connected'}</span>}
            <span className="pill sim">Simulated always on</span>
          </p>
          {bridge?.camera.sdk_version && <p className="muted small">Browser camera runs Presage SDK {bridge.camera.sdk_version}</p>}
          <p className="muted small">Your camera streams to the Presage SDK on this server only while a check or reading runs. {me?.role === 'owner' ? 'The desktop bridge keeps video on your own machine.' : 'The simulated sensor replays synthetic signals through the same verifier.'}</p>
          <Button className="btn" onAct={practice} busyLabel="Starting…" data-testid="home-practice">Start a practice round</Button>
        </section>
        <section className="card">
          <h3>What gets checked</h3>
          <ul className="plain small">
            <li>Follows this exact pattern</li>
            <li>Beats 20 decoy patterns</li>
            <li>Inhale and exhale timing</li>
            <li>Number of breaths</li>
            <li>A live pulse signal</li>
          </ul>
          <Link className="btn" to="/rules">See the rules</Link>
        </section>
        <section className="card">
          <h3>What stays honest</h3>
          <p className="muted small">It proves a live, attentive person followed a fresh pattern. It is an attention gate, not identity authentication, and a person with admin rights can remove it.</p>
          <div className="row">
            <Link className="btn" to="/receipts">Receipts</Link>
            <Link className="btn" to="/evaluation">Evaluation</Link>
          </div>
        </section>
      </div>
    </main>
  );
}
