import { redirect } from 'next/navigation';
import { getSession, homeFor } from '@/lib/auth/session';
import { LoginForm } from './login-form';

export default async function LoginPage() {
  const session = await getSession();
  if (session) redirect(homeFor(session.role));

  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <div className="w-full max-w-sm">
        <h1 className="text-2xl font-semibold">Campus Complaints</h1>
        <p className="mt-1 text-sm text-muted">Report an issue. We&apos;ll work out the details.</p>
        <LoginForm />
        <div className="mt-8 rounded-lg border border-line bg-surface p-4 text-xs text-muted">
          <p className="font-medium text-foreground">Demo accounts (password: password123)</p>
          <ul className="mt-2 space-y-1">
            <li>student@campus.edu — student</li>
            <li>staff@campus.edu — IT staff</li>
            <li>manager@campus.edu — IT department manager</li>
            <li>admin@campus.edu — admin</li>
          </ul>
        </div>
      </div>
    </main>
  );
}
