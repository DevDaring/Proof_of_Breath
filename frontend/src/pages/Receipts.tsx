import { Fragment, useCallback, useEffect, useState } from 'react';
import { api, downloadJson, message, Receipt, STATUS_TEXT } from '../lib/api';
import { Button, Empty, Spinner, useToast } from '../components/ui';

const PAGE = 25;

export function Receipts() {
  const toast = useToast();
  const [items, setItems] = useState<Receipt[] | null>(null);
  const [total, setTotal] = useState(0);
  const [chain, setChain] = useState<any>(null);
  const [selected, setSelected] = useState<string | null>(null);

  const verify = useCallback(async () => {
    try {
      setChain(await api.get('/api/receipts/verify-chain'));
    } catch (err) {
      toast(message(err), 'error');
    }
  }, [toast]);

  const load = useCallback(async () => {
    try {
      const out = await api.get<{ total: number; items: Receipt[] }>(`/api/receipts?limit=${PAGE}`);
      setItems(out.items);
      setTotal(out.total);
    } catch (err) {
      toast(message(err), 'error');
      setItems([]);
    }
  }, [toast]);

  useEffect(() => {
    load();
    verify();
  }, [load, verify]);

  const more = async () => {
    try {
      const out = await api.get<{ total: number; items: Receipt[] }>(`/api/receipts?limit=${PAGE}&offset=${items?.length ?? 0}`);
      setItems((prev) => [...(prev ?? []), ...out.items]);
      setTotal(out.total);
    } catch (err) {
      toast(message(err), 'error');
    }
  };

  return (
    <main className="page">
      <div className="row between wrap">
        <h1>Receipts</h1>
        <div className="row wrap">
          {chain && (
            <span className={`pill ${chain.valid ? 'live' : 'bad-pill'}`} data-testid="chain-badge">
              {chain.valid ? `Chain verified · ${chain.checked} receipts` : `Chain broken: ${chain.reason}`}
            </span>
          )}
          <Button className="btn" onAct={async () => { await load(); await verify(); toast('Chain checked'); }} busyLabel="Checking…" data-testid="verify-chain">Verify chain</Button>
          <Button className="btn" onAct={async () => { try { await downloadJson('/api/receipts/export', 'pob-receipts.json'); toast('Export downloaded'); } catch (err) { toast(message(err), 'error'); } }} busyLabel="Exporting…" data-testid="export-receipts">Export JSON</Button>
        </div>
      </div>
      <p className="muted">Each receipt includes the hash of the one before it, so an edit, deletion or reorder breaks the chain. Commands are stored as SHA-256 hashes unless you turn on command text.</p>
      {items === null ? <Spinner /> : items.length === 0 ? <Empty>No decisions yet. Run a command through the gate to create the first receipt.</Empty> : (
        <div className="table-wrap card">
          <table data-testid="receipts-table">
            <thead><tr><th>#</th><th>When</th><th>Decision</th><th>Method</th><th>Source</th><th>Command hash</th><th aria-label="Details" /></tr></thead>
            <tbody>
              {items.map((r) => (
                <Fragment key={r.id}>
                  <tr>
                    <td>{r.seq}</td>
                    <td>{new Date(r.created_at).toLocaleString()}</td>
                    <td><span className={`pill dec-${r.decision}`}>{STATUS_TEXT[r.decision] ?? r.decision}</span></td>
                    <td>{r.method}</td>
                    <td>{r.source}</td>
                    <td className="mono small">{r.command_sha256.slice(0, 16)}…</td>
                    <td><button type="button" className="link" data-testid="receipt-details" onClick={() => setSelected(selected === r.id ? null : r.id)}>{selected === r.id ? 'Hide' : 'Details'}</button></td>
                  </tr>
                  {selected === r.id && (
                    <tr>
                      <td colSpan={7}><pre className="detail" data-testid="receipt-detail">{JSON.stringify({ request_id: r.request_id, command_sha256: r.command_sha256, prev_hash: r.prev_hash, hash: r.hash, scores: r.scores }, null, 2)}</pre></td>
                    </tr>
                  )}
                </Fragment>
              ))}
            </tbody>
          </table>
          {items.length < total && <div className="row end"><Button className="btn" onAct={more} data-testid="load-more">Load more</Button></div>}
        </div>
      )}
    </main>
  );
}
