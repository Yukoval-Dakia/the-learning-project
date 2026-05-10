export default function Home() {
  return (
    <main className="mx-auto max-w-3xl px-4 py-16">
      <h1 className="text-3xl font-semibold">Loom</h1>
      <p className="mt-3 text-sm text-slate-600">
        Stack migration in progress (Sub 0a). UI lands in Sub 0b.
      </p>
      <p className="mt-6 text-xs text-slate-500">
        Health check: <a href="/api/health" className="underline">/api/health</a>
      </p>
    </main>
  );
}
