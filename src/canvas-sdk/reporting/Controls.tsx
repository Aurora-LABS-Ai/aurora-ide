import { useId } from "react";

interface TextControlProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}

export function SearchField({ label, value, onChange, disabled }: TextControlProps) {
  const id = useId();
  return <label className="ac-report-control" htmlFor={id}><span>{label}</span>
    <input id={id} type="search" value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)} />
  </label>;
}

export interface SelectOption { value: string; label: string }

export function SelectField({ label, value, options, onChange, disabled }: TextControlProps & { options: SelectOption[] }) {
  const id = useId();
  return <div className="ac-report-control"><label htmlFor={id}>{label}</label>
    <select id={id} value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)}>
      <option value="">All</option>
      {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
    </select>
  </div>;
}

export function MultiSelect({ label, value, options, onChange, disabled }: {
  label: string; value: string[]; options: SelectOption[]; onChange: (value: string[]) => void; disabled?: boolean;
}) {
  return <fieldset className="ac-report-multi" disabled={disabled}><legend>{label}</legend>
    <div className="ac-report-options">{options.map((option) => <label key={option.value}>
      <input type="checkbox" checked={value.includes(option.value)} onChange={(event) => onChange(event.target.checked ? [...value, option.value] : value.filter((entry) => entry !== option.value))} />
      <span>{option.label}</span>
    </label>)}</div>
    <span className="ac-report-hint">{value.length ? `${value.length} selected` : "All included"}</span>
  </fieldset>;
}

export function RangeField({ label, value, onChange, kind = "number", disabled }: {
  label: string; value: { min: string; max: string }; onChange: (value: { min: string; max: string }) => void; kind?: "number" | "date"; disabled?: boolean;
}) {
  const id = useId();
  const invalid = !!value.min && !!value.max && (kind === "date" ? value.min > value.max : Number(value.min) > Number(value.max));
  return <fieldset className="ac-report-range" disabled={disabled}><legend>{label}</legend>
    <div>{(["min", "max"] as const).map((bound) => <label key={bound}>
      <span>{kind === "date" ? bound === "min" ? "From" : "Through" : bound === "min" ? "Minimum" : "Maximum"}</span>
      <input type={kind} step={kind === "number" ? "any" : undefined} value={value[bound]} aria-invalid={invalid || undefined} aria-describedby={invalid ? id : undefined} onChange={(event) => onChange({ ...value, [bound]: event.target.value })} />
    </label>)}</div>
    {invalid && <span id={id} className="ac-report-error">The minimum must be at or below the maximum.</span>}
  </fieldset>;
}

export function Toggle({ label, checked, onChange, disabled }: {
  label: string; checked: boolean; onChange: (checked: boolean) => void; disabled?: boolean;
}) {
  return <label className="ac-report-toggle"><input type="checkbox" checked={checked} disabled={disabled} onChange={(event) => onChange(event.target.checked)} /><span>{label}</span></label>;
}
