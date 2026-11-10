export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  let reply: Response;
  try {
    reply = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(0, 'network', 'Could not reach the server. Please check your connection and try again.');
  }
  let data: any = null;
  try {
    data = await reply.json();
  } catch {
    // Handled below when the status is an error.
  }
  if (!reply.ok) {
    if (reply.status === 401 && data?.code !== 'bad_credentials' && !location.pathname.startsWith('/login')) {
      const next = encodeURIComponent(location.pathname + location.search);
      location.assign(`/login?next=${next}`);
    }
    throw new ApiError(reply.status, data?.code ?? 'error', data?.detail ?? 'Something went wrong. Please try again.');
  }
  return data as T;
}

export const api = {
  get: <T,>(path: string) => request<T>('GET', path),
  post: <T,>(path: string, body: unknown = {}) => request<T>('POST', path, body),
  put: <T,>(path: string, body: unknown) => request<T>('PUT', path, body),
  del: <T,>(path: string) => request<T>('DELETE', path),
};

/** Download through a same-origin link so the session cookie applies and the CSP stays strict. */
export async function downloadJson(path: string, filename: string) {
  const data = await api.get<unknown>(path);
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

export const message = (err: unknown) => (err instanceof Error ? err.message : 'Something went wrong. Please try again.');

export interface Me {
  role: 'owner' | 'jury' | 'interceptor';
  username: string;
  consents: string[];
  consent_version: string;
  polarity: number | null;
  runtime_llm_enabled: boolean;
  live_available: boolean;
}

export interface Phase { kind: 'delay' | 'inhale' | 'exhale' | 'pause'; duration: number }

export interface Scores {
  s_xcorr: number; s_phase: number; s_cycles: number; target_cycles: number; s_live: number; s_decoy: number;
  s_coupling: number; s_coupling_decoy: number; best_lag_s: number; passed: boolean; failure_reasons: string[]; failures?: string[];
}

export interface GateView {
  id: string; source: string; source_label: string; command: string | null; command_sha256: string; cwd: string | null;
  reason: string | null; severity: string | null; status: string; purpose: string; simulated: boolean; created_at: string; decided_at: string | null;
  attempts_used: number; max_attempts: number; fallback_target: string | null; fallback_seconds_left: number | null;
  thresholds: Record<string, number> | null; gates: Record<string, boolean> | null; last_attempt: Scores | null;
}

export interface Rule { id: string; key: string | null; scope: string; pattern: string; severity: string; reason: string; enabled: boolean; is_default: boolean }

export interface Settings {
  thresholds: Record<string, number>; enabled_gates: Record<string, boolean>; thresholds_calibrated: boolean; breath_polarity: number | null;
  telemetry_opt_out: boolean; store_command_text: boolean; runtime_llm_enabled: boolean; runtime_llm_available: boolean; updated_at: string;
}

export interface Receipt {
  id: string; seq: number; request_id: string | null; command_sha256: string; source: string; decision: string; method: string;
  scores: Record<string, unknown>; created_at: string; prev_hash: string; hash: string;
}

export const STATUS_TEXT: Record<string, string> = {
  pending: 'Waiting', approved: 'Approved', denied: 'Denied', expired: 'Expired', fallback_approved: 'Approved by fallback',
  practice_passed: 'Passed (no command ran)',
};
