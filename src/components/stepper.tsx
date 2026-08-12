import type { Step } from '@/lib/lifecycle/stepper';

/**
 * §20's tracker. The steps and their states are decided in
 * `lib/lifecycle/stepper.ts`; this only draws them.
 */
export function Stepper({ steps }: { steps: Step[] }) {
  return (
    <ol className="space-y-3">
      {steps.map((step) => (
        <li key={step.key} className="flex items-start gap-3">
          <span
            aria-hidden
            className={`mt-0.5 w-4 shrink-0 text-center text-sm ${
              step.state === 'DONE'
                ? 'text-green-700'
                : step.state === 'CURRENT'
                  ? 'text-blue-700'
                  : 'text-muted'
            }`}
          >
            {step.state === 'DONE' ? '✓' : step.state === 'CURRENT' ? '●' : '○'}
          </span>
          <div className="min-w-0 flex-1">
            <p
              className={`text-sm ${
                step.state === 'PENDING' ? 'text-muted' : 'font-medium'
              }`}
            >
              {step.label}
            </p>
            {step.note && <p className="text-xs text-blue-800">{step.note}</p>}
          </div>
          {step.at && (
            <span className="shrink-0 text-xs text-muted">
              {step.at.toLocaleString('en-IN')}
            </span>
          )}
        </li>
      ))}
    </ol>
  );
}
