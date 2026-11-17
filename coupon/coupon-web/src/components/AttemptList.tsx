export interface Attempt {
  id: number;
  action: string;
  code: string;
  at: string;
}

interface Props {
  attempts: Attempt[];
}

export function AttemptList({ attempts }: Props) {
  if (attempts.length === 0) {
    return <p className="attempts__empty">Nothing tried yet.</p>;
  }

  return (
    <ol className="attempts">
      {attempts.map((attempt) => (
        <li key={attempt.id}>
          <span className="attempts__action">{attempt.action}</span>
          <code className="attempts__code">{attempt.code}</code>
          <span className="attempts__time">{attempt.at}</span>
        </li>
      ))}
    </ol>
  );
}
