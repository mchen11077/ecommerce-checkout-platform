import { useEffect, useId, useRef } from 'react';

interface Choice { value: string; label: string }

export function ChoicePicker({ label, value, options, onChange, disabled = false }: {
  label: string;
  value: string;
  options: Choice[];
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  const id = useId();
  const picker = useRef<HTMLDetailsElement>(null);
  const trigger = useRef<HTMLElement>(null);
  useEffect(() => {
    const close = (event: PointerEvent) => {
      if (event.target instanceof Node && !picker.current?.contains(event.target)) picker.current?.removeAttribute('open');
    };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, []);
  return <div className="retail-choice">
    <span id={id}>{label}</span>
    <details ref={picker} onKeyDown={event => {
      if (event.key === 'Escape') {
        picker.current?.removeAttribute('open');
        trigger.current?.focus();
      }
    }}>
      <summary ref={trigger} aria-labelledby={`${id} ${id}-value`} aria-disabled={disabled}
        onClick={event => { if (disabled) event.preventDefault(); }}>
        <span id={`${id}-value`}>{options.find(option => option.value === value)?.label}</span>
      </summary>
      <div className="retail-choice-options" role="group" aria-label={`${label} options`}>
        {options.map(option => <button type="button" key={option.value} disabled={disabled}
          aria-pressed={option.value === value} onClick={() => {
            onChange(option.value);
            picker.current?.removeAttribute('open');
            trigger.current?.focus();
          }}>{option.label}</button>)}
      </div>
    </details>
  </div>;
}
