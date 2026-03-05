"use client"

import * as React from "react"
import { RegistrationStepper, type RegistrationStep } from "@/components/ui/registration-stepper"

export default function Page() {
  const [current, setCurrent] = React.useState("account")

  const steps: RegistrationStep[] = [
    { id: "account", title: "Create your MyIntealth account", description: "Create account and verify identity.", status: "completed" },
    { id: "establish", title: "Account Establishment", description: "Your EPIC account is being finalised.", status: "current" },
    { id: "upload", title: "Upload specialist qualifications", description: "Upload credentials and nominate AMC.", status: "locked" },
    { id: "verify", title: "EPIC is verifying your documents", description: "EPIC checks the uploaded credentials.", status: "locked" },
    { id: "issued", title: "Verification issued", description: "You can move to the AMC module.", status: "locked" },
  ]

  return (
    <div className="min-h-screen w-full bg-background p-6">
      <div className="mx-auto max-w-5xl">
        <RegistrationStepper
          steps={steps}
          currentStepId={current}
          onStepClick={(id) => setCurrent(id)}
          onLockedStepClick={() => alert("Complete the previous step to unlock this.")}
        />
      </div>
    </div>
  )
}
