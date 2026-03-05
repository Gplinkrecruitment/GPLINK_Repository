"use client"

import * as React from "react"
import { RegistrationStepper, type RegistrationStep } from "@/components/ui/registration-stepper"

const ORDER = ["account", "establish", "upload", "verify", "issued"] as const

type StepId = (typeof ORDER)[number]

const META: Record<StepId, { title: string; description: string }> = {
  account: {
    title: "Create your MyIntealth account",
    description: "Create account and verify identity.",
  },
  establish: {
    title: "Account Establishment",
    description: "Your EPIC account is being finalised.",
  },
  upload: {
    title: "Upload specialist qualifications",
    description: "Upload credentials and nominate AMC.",
  },
  verify: {
    title: "EPIC is verifying your documents",
    description: "EPIC checks the uploaded credentials.",
  },
  issued: {
    title: "Verification issued",
    description: "You can move to the AMC module.",
  },
}

function buildSteps(current: StepId): RegistrationStep[] {
  const currentIndex = ORDER.indexOf(current)
  return ORDER.map((id, index) => {
    let status: RegistrationStep["status"] = "locked"
    if (index < currentIndex) status = "completed"
    if (index === currentIndex) status = "current"
    return {
      id,
      title: META[id].title,
      description: META[id].description,
      status,
    }
  })
}

export default function MyIntealthPage() {
  const [current, setCurrent] = React.useState<StepId>("establish")
  const [toast, setToast] = React.useState("")

  React.useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(() => setToast(""), 1800)
    return () => window.clearTimeout(timer)
  }, [toast])

  return (
    <main className="min-h-screen w-full bg-background p-6">
      <div className="mx-auto max-w-6xl space-y-4">
        <h1 className="text-2xl font-semibold">MyIntealth</h1>
        <RegistrationStepper
          steps={buildSteps(current)}
          currentStepId={current}
          onStepClick={(id) => setCurrent(id as StepId)}
          onLockedStepClick={() => setToast("Complete the previous step to unlock this.")}
        />

        {toast ? (
          <div className="fixed bottom-6 left-1/2 -translate-x-1/2 rounded-md bg-foreground px-4 py-2 text-sm font-medium text-background">
            {toast}
          </div>
        ) : null}
      </div>
    </main>
  )
}
