import type { Tone } from '../messages.js';

interface Props {
  code: string;
  message: string;
  tone: Tone;
  status?: number;
}

export function ResultBanner({ code, message, tone, status }: Props) {
  return (
    <div className={`banner banner--${tone}`} role="status" aria-live="polite">
      <div className="banner__head">
        <span className="banner__message">{message}</span>
        {status !== undefined && <span className="banner__status">HTTP {status}</span>}
      </div>
      <code className="banner__code">{code}</code>
    </div>
  );
}
