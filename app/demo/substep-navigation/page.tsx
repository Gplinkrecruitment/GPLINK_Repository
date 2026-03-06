"use client"

import * as React from "react"
import { SubstepNavigation } from "@/components/ui/substep-navigation"
import type { Substep } from "@/types/registration"

const INITIAL_SUBSTEPS: Substep[] = [
  {
    id: "create-account",
    title: "Create MyIntealth Account",
    description: "Set up your MyIntealth account and verify your email address.",
    status: "complete",
    completed: true,
    gpAction: "Create your account on the MyIntealth portal using your email.",
    gpLinkAction: "We verify your account creation and flag any issues.",
    estimatedTime: "10 minutes",
    helperText: "Once created, you will proceed to personal details verification.",
    primaryActionLabel: "Open MyIntealth",
    secondaryActionLabel: "Get Help",
  },
  {
    id: "verify-details",
    title: "Verify Personal Details",
    description: "Confirm your name, date of birth, and contact information match your passport.",
    status: "complete",
    completed: true,
    gpAction: "Review and confirm your personal details match your passport exactly.",
    gpLinkAction: "We cross-check your details against known EPIC requirements.",
    estimatedTime: "5 minutes",
    helperText: "Accurate details prevent delays during EPIC verification.",
    primaryActionLabel: "Open MyIntealth",
  },
  {
    id: "upload-passport",
    title: "Upload Passport",
    description: "Upload a certified colour copy of your current passport bio page.",
    status: "current",
    gpAction: "Upload a clear, certified colour copy of your passport bio page.",
    gpLinkAction: "We review your upload for clarity and certification before submission.",
    estimatedTime: "5 minutes",
    warning: "Passport must be certified by an approved certifier. Uncertified copies will be rejected.",
    helperText: "After uploading, you will upload your specialist qualification documents.",
    primaryActionLabel: "Open MyIntealth",
    secondaryActionLabel: "Certification Guide",
  },
  {
    id: "upload-qualifications",
    title: "Upload Qualification Documents",
    description: "Upload certified copies of your specialist qualification (e.g. MRCGP, MICGP, FRNZCGP).",
    status: "upcoming",
    gpAction: "Upload certified copies of your specialist qualification certificate and primary medical degree.",
    gpLinkAction: "We verify document quality and ensure AMC is nominated as the report recipient.",
    estimatedTime: "10-15 minutes",
    helperText: "Both your specialist qualification and primary medical degree are required.",
    primaryActionLabel: "Open MyIntealth",
    secondaryActionLabel: "Document Checklist",
  },
  {
    id: "notarycam-session",
    title: "Complete NotaryCam Session",
    description: "Complete your identity verification through a live NotaryCam video session.",
    status: "upcoming",
    gpAction: "Schedule and complete a NotaryCam video session to verify your identity.",
    gpLinkAction: "We provide guidance on booking and preparing for the session.",
    estimatedTime: "15-20 minutes",
    helperText: "NotaryCam verifies your identity in real-time via a brief video call.",
    primaryActionLabel: "Schedule NotaryCam",
  },
  {
    id: "submit-verification",
    title: "Submit EPIC Verification Request",
    description: "Submit your complete application to EPIC for credential verification.",
    status: "locked",
    locked: true,
    gpAction: "Review and submit your verification request once all documents are uploaded.",
    gpLinkAction: "We do a final check of your submission before you confirm.",
    estimatedTime: "5 minutes",
    helperText: "Once submitted, EPIC will begin reviewing your credentials.",
  },
  {
    id: "await-outcome",
    title: "Await EPIC Verification Outcome",
    description: "EPIC reviews your credentials. This process typically takes 1-3 weeks.",
    status: "locked",
    locked: true,
    gpAction: "No action required. EPIC is processing your verification.",
    gpLinkAction: "We monitor progress weekly and escalate delays on your behalf.",
    estimatedTime: "1-3 weeks",
    helperText: "We will notify you as soon as the outcome is available.",
  },
]

export default function SubstepNavigationDemo() {
  const [substeps, setSubsteps] = React.useState<Substep[]>(INITIAL_SUBSTEPS)
  const [currentId, setCurrentId] = React.useState("upload-passport")

  const handleSubstepChange = React.useCallback((id: string) => {
    setCurrentId(id)
  }, [])

  const handleNext = React.useCallback(() => {
    const idx = substeps.findIndex((s) => s.id === currentId)
    if (idx < substeps.length - 1) {
      const next = substeps[idx + 1]
      if (next.status !== "locked" && !next.locked) {
        setCurrentId(next.id)
      }
    }
  }, [substeps, currentId])

  const handlePrevious = React.useCallback(() => {
    const idx = substeps.findIndex((s) => s.id === currentId)
    if (idx > 0) {
      setCurrentId(substeps[idx - 1].id)
    }
  }, [substeps, currentId])

  const handlePrimaryAction = React.useCallback((id: string) => {
    console.log("Primary action for:", id)
    // In real usage: open MyIntealth, schedule NotaryCam, etc.
  }, [])

  const handleSecondaryAction = React.useCallback((id: string) => {
    console.log("Secondary action for:", id)
  }, [])

  const handleMarkComplete = React.useCallback(
    (id: string) => {
      setSubsteps((prev) => {
        const updated = prev.map((s) => {
          if (s.id === id) {
            return { ...s, status: "complete" as const, completed: true }
          }
          return s
        })

        // Unlock the next step if it was upcoming
        const idx = updated.findIndex((s) => s.id === id)
        if (idx < updated.length - 1) {
          const next = updated[idx + 1]
          if (next.status === "upcoming" || next.status === "locked") {
            updated[idx + 1] = {
              ...next,
              status: "current" as const,
              locked: false,
            }
            setCurrentId(next.id)
          }
        }

        return updated
      })
    },
    [],
  )

  return (
    <div className="min-h-screen bg-[#f0f4fa]">
      <div className="mx-auto max-w-[920px] px-4 py-8">
        {/* Page header */}
        <div className="mb-6">
          <a
            href="/demo/stepper"
            className="inline-flex items-center gap-1.5 text-[13px] font-semibold text-blue-600 hover:underline mb-3"
          >
            <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M19 12H5" /><path d="M12 19l-7-7 7-7" />
            </svg>
            Back to Dashboard
          </a>
          <h1 className="text-[22px] font-extrabold text-slate-900 tracking-tight">
            MyIntealth / EPIC Verification
          </h1>
          <p className="text-[13px] text-slate-500 font-medium mt-1">
            Follow each step to complete your EPIC credential verification.
          </p>
        </div>

        {/* Substep Navigation */}
        <SubstepNavigation
          substeps={substeps}
          currentSubstepId={currentId}
          onSubstepChange={handleSubstepChange}
          onNext={handleNext}
          onPrevious={handlePrevious}
          onPrimaryAction={handlePrimaryAction}
          onSecondaryAction={handleSecondaryAction}
          onMarkComplete={handleMarkComplete}
          workflowTitle="MyIntealth Process"
        />

        {/* Simulated action-required state toggle */}
        <div className="mt-8 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <h3 className="text-[14px] font-bold text-slate-700 mb-3">Demo Controls</h3>
          <p className="text-[12px] text-slate-500 mb-3">
            Test different states by clicking the buttons below.
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => {
                setSubsteps((prev) =>
                  prev.map((s) =>
                    s.id === "upload-passport"
                      ? {
                          ...s,
                          status: "action-required" as const,
                          actionRequired: true,
                          warning:
                            "EPIC has rejected your passport upload. The copy was not certified. Please upload a new certified colour copy.",
                        }
                      : s,
                  ),
                )
              }}
              className="rounded-lg bg-amber-50 border border-amber-200 px-3 py-1.5 text-[12px] font-bold text-amber-700 hover:bg-amber-100 transition-colors"
            >
              Simulate: Passport Rejected
            </button>
            <button
              type="button"
              onClick={() => {
                setSubsteps(INITIAL_SUBSTEPS)
                setCurrentId("upload-passport")
              }}
              className="rounded-lg bg-slate-50 border border-slate-200 px-3 py-1.5 text-[12px] font-bold text-slate-600 hover:bg-slate-100 transition-colors"
            >
              Reset to Default
            </button>
            <button
              type="button"
              onClick={() => {
                setSubsteps((prev) =>
                  prev.map((s) => ({
                    ...s,
                    status: "complete" as const,
                    completed: true,
                    locked: false,
                  })),
                )
                setCurrentId("await-outcome")
              }}
              className="rounded-lg bg-emerald-50 border border-emerald-200 px-3 py-1.5 text-[12px] font-bold text-emerald-700 hover:bg-emerald-100 transition-colors"
            >
              Simulate: All Complete
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
