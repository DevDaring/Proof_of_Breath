import { useCallback, useEffect, useState } from 'react';
import { api, message, Rule } from '../lib/api';
import { Button, Confirm, Empty, Spinner, Toggle, useToast } from '../components/ui';

interface Draft { id: string | null; scope: string; pattern: string; severity: string; reason: string }
const BLANK: Draft = { id: null, scope: 'shell', pattern: '', severity: 'high', reason: '' };

function TestBox({ pattern }: { pattern: string }) {
  const [sample, setSample] = useState('');
  const [out, setOut] = useState<{ valid: boolean; error: string | null; matches: boolean } | null>(null);
  useEffect(() => {
    if (!pattern) {
      setOut(null);
      return;
    }
    let alive = true;
    const timer = setTimeout(() => {
      api.post<any>('/api/rules/test', { pattern, sample }).then((r) => alive && setOut(r)).catch(() => undefined);
    }, 200);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [pattern, sample]);
  return (
    <div className="test-box">
      <label>
        Live test
        <input className="mono" value={sample} onChange={(e) => setSample(e.target.value)} placeholder="Type a command to test" data-testid="rule-sample" spellCheck={false} />
      </label>
      <div data-testid="rule-test-result" aria-live="polite">
        {out && !out.valid && <span className="bad">{out.error}</span>}
        {out?.valid && sample && (out.matches ? <span className="bad">Gated: this command would be held</span> : <span className="good">Not gated by this rule</span>)}
      </div>
    </div>
  );
}

export function Rules() {
  const toast = useToast();
  const [rules, setRules] = useState<Rule[] | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [removing, setRemoving] = useState<Rule | null>(null);

  const load = useCallback(async () => {
    try {
      setRules(await api.get<Rule[]>('/api/rules'));
    } catch (err) {
      toast(message(err), 'error');
      setRules([]);
    }
  }, [toast]);

  useEffect(() => {
    load();
  }, [load]);

  const toggle = async (rule: Rule, enabled: boolean) => {
    setRules((list) => list?.map((r) => (r.id === rule.id ? { ...r, enabled } : r)) ?? null);
    try {
      await api.put(`/api/rules/${rule.id}`, { enabled });
    } catch (err) {
      toast(message(err), 'error');
      load();
    }
  };

  const save = async () => {
    if (!draft) return;
    const body = { scope: draft.scope, pattern: draft.pattern, severity: draft.severity, reason: draft.reason };
    try {
      if (draft.id) await api.put(`/api/rules/${draft.id}`, body);
      else await api.post('/api/rules', body);
      setDraft(null);
      toast('Rule saved');
      await load();
    } catch (err) {
      toast(message(err), 'error');
    }
  };

  const remove = async () => {
    if (!removing) return;
    try {
      await api.del(`/api/rules/${removing.id}`);
      toast('Rule deleted');
      setRemoving(null);
      await load();
    } catch (err) {
      toast(message(err), 'error');
    }
  };

  return (
    <main className="page">
      <div className="row between wrap">
        <h1>Rules</h1>
        <button type="button" className="btn primary" onClick={() => setDraft({ ...BLANK })} data-testid="add-rule">Add a rule</button>
      </div>
      <p className="muted">Rules are plain regular expressions, checked in order. No AI ever decides what is gated, because an AI could be talked out of it by the same agent this guards against.</p>

      {draft && (
        <section className="card" data-testid="rule-form">
          <h2>{draft.id ? 'Edit rule' : 'New rule'}</h2>
          <label>
            Pattern
            <input className="mono" value={draft.pattern} onChange={(e) => setDraft({ ...draft, pattern: e.target.value })} data-testid="rule-pattern" spellCheck={false} maxLength={500} />
          </label>
          <TestBox pattern={draft.pattern} />
          <label>
            Reason shown in the gate window
            <input value={draft.reason} onChange={(e) => setDraft({ ...draft, reason: e.target.value })} data-testid="rule-reason" maxLength={300} />
          </label>
          <div className="row wrap">
            <label>
              Scope
              <select value={draft.scope} onChange={(e) => setDraft({ ...draft, scope: e.target.value })} data-testid="rule-scope">
                <option value="shell">shell</option>
                <option value="sql">sql</option>
                <option value="git">git</option>
              </select>
            </label>
            <label>
              Severity
              <select value={draft.severity} onChange={(e) => setDraft({ ...draft, severity: e.target.value })} data-testid="rule-severity">
                <option value="low">low</option>
                <option value="medium">medium</option>
                <option value="high">high</option>
                <option value="critical">critical</option>
              </select>
            </label>
          </div>
          <div className="row end">
            <button type="button" className="btn" onClick={() => setDraft(null)} data-testid="rule-cancel">Cancel</button>
            <Button className="btn primary" disabled={!draft.pattern.trim() || !draft.reason.trim()} onAct={save} busyLabel="Saving…" data-testid="rule-save">Save rule</Button>
          </div>
        </section>
      )}

      {rules === null ? <Spinner /> : rules.length === 0 ? <Empty>No rules.</Empty> : (
        <div className="rule-list">
          {rules.map((rule) => (
            <article className="card rule" key={rule.id} data-testid="rule-row">
              <div className="row between wrap">
                <Toggle checked={rule.enabled} onChange={(next) => toggle(rule, next)} label={rule.reason} testid="rule-toggle" />
                <div className="row">
                  <span className="pill">{rule.scope}</span>
                  <span className={`pill sev-${rule.severity}`}>{rule.severity}</span>
                  {!rule.is_default && <span className="pill live">custom</span>}
                </div>
              </div>
              <code className="pattern">{rule.pattern}</code>
              <div className="row">
                <button type="button" className="link" onClick={() => setDraft({ id: rule.id, scope: rule.scope, pattern: rule.pattern, severity: rule.severity, reason: rule.reason })} data-testid="rule-edit">Edit</button>
                {!rule.is_default && <button type="button" className="link bad" onClick={() => setRemoving(rule)} data-testid="rule-delete">Delete</button>}
              </div>
            </article>
          ))}
        </div>
      )}
      {removing && <Confirm title="Delete this rule?" body={removing.reason} confirmLabel="Delete rule" onConfirm={remove} onCancel={() => setRemoving(null)} />}
    </main>
  );
}
