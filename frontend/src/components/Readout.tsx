export interface ReadoutValues { pulse_bpm: number | null; pulse_conf: number | null; breath_rpm: number | null; breath_conf: number | null }

function Meter({ value }: { value: number | null }) {
  const v = Math.max(0, Math.min(100, value ?? 0));
  return (
    <span className="meter" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={value ?? 0} aria-label="SDK confidence">
      <span style={{ width: `${v}%` }} className={v >= 45 ? 'ok' : ''} />
    </span>
  );
}

/** The SDK's own numbers, shown as reported. They are for display and never decide a check. */
export function Readout({ values, live, compact }: { values: ReadoutValues | null; live: boolean; compact?: boolean }) {
  const pulse = values?.pulse_bpm ?? null;
  const breath = values?.breath_rpm ?? null;
  return (
    <div className={`readout ${compact ? 'compact' : ''}`} data-testid="readout">
      <div className="vital pulse">
        <span className="vital-label"><i className={`beat ${live && pulse ? 'on' : ''}`} style={pulse ? { animationDuration: `${60 / pulse}s` } : undefined} aria-hidden="true" />Pulse</span>
        <span className="vital-value" data-testid="readout-pulse">{pulse ? Math.round(pulse) : <span className="none">--</span>}<small>bpm</small></span>
        <span className="vital-conf"><Meter value={values?.pulse_conf ?? null} /> <small className="muted">{values?.pulse_conf != null ? `${Math.round(values.pulse_conf)}% confidence` : live ? 'Warming up, about 12 s' : 'No reading yet'}</small></span>
      </div>
      <div className="vital breath">
        <span className="vital-label"><i className={`lung ${live && breath ? 'on' : ''}`} style={breath ? { animationDuration: `${60 / breath}s` } : undefined} aria-hidden="true" />Breathing rate</span>
        <span className="vital-value" data-testid="readout-breath">{breath ? breath.toFixed(1) : <span className="none">--</span>}<small>per min</small></span>
        <span className="vital-conf"><Meter value={values?.breath_conf ?? null} /> <small className="muted">{values?.breath_conf != null ? `${Math.round(values.breath_conf)}% confidence` : live ? 'Needs a few breaths' : 'No reading yet'}</small></span>
      </div>
    </div>
  );
}
