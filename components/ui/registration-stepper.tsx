"use client"

import * as React from "react"
import { cn } from "@/lib/utils"
import { CheckIcon, LockIcon, AlertTriangleIcon, Loader2Icon } from "lucide-react"

export type StepStatus = "completed" | "current" | "locked" | "waiting" | "action_required"

export type RegistrationStep = {
  id: string
  title: string
  description?: string
  status: StepStatus
}

type Props = {
  steps: RegistrationStep[]
  currentStepId: string
  onStepClick?: (stepId: string) => void
  onLockedStepClick?: (stepId: string) => void
  className?: string
}

export function RegistrationStepper({
  steps,
  currentStepId,
  onStepClick,
  onLockedStepClick,
  className,
}: Props) {
  const containerRef = React.useRef<HTMLDivElement | null>(null)
  const itemRefs = React.useRef<Record<string, HTMLButtonElement | null>>({})

  const currentIndex = Math.max(
    0,
    steps.findIndex((s) => s.id === currentStepId),
  )

  const [fillWidth, setFillWidth] = React.useState(0)

  const computeFill = React.useCallback(() => {
    const container = containerRef.current
    const current = itemRefs.current[currentStepId]
    if (!container || !current) return

    const containerRect = container.getBoundingClientRect()
    const currentRect = current.getBoundingClientRect()

    const startX = 0
    const endX = currentRect.left - containerRect.left + currentRect.width / 2
    setFillWidth(Math.max(startX, endX))
  }, [currentStepId])

  React.useEffect(() => {
    computeFill()
    const onResize = () => computeFill()
    window.addEventListener("resize", onResize)
    return () => window.removeEventListener("resize", onResize)
  }, [computeFill])

  React.useEffect(() => {
    const container = containerRef.current
    const current = itemRefs.current[currentStepId]
    if (!container || !current) return

    const isMobileScroll = container.scrollWidth > container.clientWidth
    if (!isMobileScroll) return

    current.scrollIntoView({ behavior: "smooth", inline: "center", block: "nearest" })
  }, [currentStepId])

  const getIcon = (status: StepStatus) => {
    if (status === "completed") return <CheckIcon className="h-4 w-4" strokeWidth={2.5} />
    if (status === "locked") return <LockIcon className="h-4 w-4" strokeWidth={2.2} />
    if (status === "action_required") return <AlertTriangleIcon className="h-4 w-4" strokeWidth={2.2} />
    if (status === "waiting") return <Loader2Icon className="h-4 w-4 animate-spin" strokeWidth={2.2} />
    return <span className="text-sm font-semibold tabular-nums">•</span>
  }

  const isClickable = (status: StepStatus) => status === "completed" || status === "current"

  return (
    <div className={cn("w-full", className)}>
      <div className="relative rounded-2xl border border-border/50 bg-background/60 p-3 backdrop-blur-xl shadow-sm">
        <div className="pointer-events-none absolute inset-0 rounded-2xl bg-[radial-gradient(circle_at_20%_0%,rgba(120,119,198,0.12),transparent_50%)]" />

        <div className="relative">
          <div
            ref={containerRef}
            className={cn(
              "relative flex items-stretch gap-3 overflow-x-auto py-3 px-2",
              "scrollbar-none",
              "snap-x snap-mandatory",
            )}
          >
            <div className="pointer-events-none absolute left-0 right-0 top-[22px] h-[2px]">
              <div className="absolute inset-0 bg-border/50" />
              <div
                className="absolute left-0 top-0 h-full bg-primary/70 transition-all duration-700 ease-out"
                style={{ width: `${fillWidth}px` }}
              />
            </div>

            {steps.map((step, idx) => {
              const active = step.id === currentStepId
              const clickable = isClickable(step.status)
              const locked = step.status === "locked"

              return (
                <button
                  key={step.id}
                  ref={(el) => {
                    itemRefs.current[step.id] = el
                  }}
                  onClick={() => {
                    if (clickable) onStepClick?.(step.id)
                    if (locked) onLockedStepClick?.(step.id)
                  }}
                  disabled={locked}
                  className={cn(
                    "relative z-10 min-w-[220px] snap-center text-left",
                    "rounded-2xl border border-border/40 bg-background/40 px-4 py-4",
                    "transition-all duration-200",
                    "hover:-translate-y-[2px] hover:shadow-md",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
                    "supports-[backdrop-filter]:bg-background/30 supports-[backdrop-filter]:backdrop-blur-xl",
                    clickable ? "cursor-pointer" : "cursor-not-allowed opacity-80",
                    active && "border-primary/40 bg-background/55",
                  )}
                >
                  <div
                    className={cn(
                      "absolute inset-0 rounded-2xl opacity-0 transition-opacity duration-200",
                      "hover:opacity-100",
                      "bg-white/5",
                      "supports-[backdrop-filter]:backdrop-blur-xl",
                    )}
                  />

                  <div className="relative flex items-start gap-3">
                    <div
                      className={cn(
                        "mt-0.5 flex h-9 w-9 items-center justify-center rounded-full border",
                        step.status === "completed" && "bg-primary text-primary-foreground border-primary/30",
                        step.status === "current" && "bg-primary text-primary-foreground border-primary/30 shadow-[0_0_22px_-8px_rgba(120,119,198,0.9)]",
                        step.status === "locked" && "bg-muted/40 text-muted-foreground border-border/50",
                        step.status === "waiting" && "bg-muted/40 text-muted-foreground border-border/50",
                        step.status === "action_required" && "bg-destructive/10 text-destructive border-destructive/20",
                      )}
                      aria-hidden="true"
                    >
                      {step.status === "current" ? <span className="h-2 w-2 rounded-full bg-current" /> : getIcon(step.status)}
                    </div>

                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <p className={cn("text-sm font-semibold leading-tight", active && "text-foreground")}>
                          {step.title}
                        </p>
                        {active && (
                          <span className="rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary">
                            Current
                          </span>
                        )}
                      </div>
                      {step.description ? (
                        <p className="mt-1 line-clamp-1 text-xs text-muted-foreground/80">{step.description}</p>
                      ) : (
                        <p className="mt-1 line-clamp-1 text-xs text-muted-foreground/60">Explain your step here.</p>
                      )}
                    </div>
                  </div>
                </button>
              )
            })}
          </div>

          <div className="pointer-events-none absolute inset-y-0 left-0 w-8 bg-gradient-to-r from-background/80 to-transparent rounded-l-2xl" />
          <div className="pointer-events-none absolute inset-y-0 right-0 w-8 bg-gradient-to-l from-background/80 to-transparent rounded-r-2xl" />
        </div>
      </div>
    </div>
  )
}
