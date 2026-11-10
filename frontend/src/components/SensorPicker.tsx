import { Sensor } from '../lib/sensors';

export function SensorPicker({ options, value, onChange, disabled }: {
  options: { id: Sensor; label: string; detail: string; ready: boolean }[]; value: Sensor; onChange: (s: Sensor) => void; disabled?: boolean;
}) {
  return (
    <div className="sensor-picker" role="radiogroup" aria-label="Sensor">
      {options.map((o) => (
        <button
          key={o.id} type="button" role="radio" aria-checked={value === o.id} disabled={disabled}
          className={`sensor-opt ${value === o.id ? 'on' : ''} ${o.ready ? '' : 'unready'}`}
          onClick={() => onChange(o.id)} data-testid={`sensor-${o.id}`}
        >
          <span className={`sensor-icon ${o.id}`} aria-hidden="true" />
          <span className="sensor-text"><strong>{o.label}</strong><small>{o.detail}</small></span>
        </button>
      ))}
    </div>
  );
}
