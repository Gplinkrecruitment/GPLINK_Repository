import Link from "next/link"

export default function HomePage() {
  return (
    <main className="min-h-screen bg-background p-8">
      <div className="mx-auto max-w-3xl space-y-4">
        <h1 className="text-2xl font-semibold">Frontend Setup Complete</h1>
        <p className="text-muted-foreground">shadcn + Tailwind + TypeScript have been configured.</p>
        <Link className="text-primary underline" href="/demo/stepper">
          Open stepper demo
        </Link>
      </div>
    </main>
  )
}
