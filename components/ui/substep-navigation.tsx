"use client"

import * as React from "react"
import { cn } from "@/lib/utils"
import type { SubstepNavigationProps, Substep } from "@/types/registration"
import { SubstepCard } from "@/components/ui/substep-card"
import { StatusBadge } from "@/components/ui/status-badge"
import {
  computeProgress,
  isNavigable,
  getNextSubstep,
  getPreviousSubstep,
} from "@/lib/substep-utils"
import {
  ChevronLeftIcon,
  ChevronRightIcon,
  AlertTriangleIcon,
  ClockIcon,
  ShieldCheckIcon,
  ArrowRightIcon,
  XIcon,
} from "lucide-react"

// ─── Progress Bar ──────────────────────────────────────────────
function ProgressBar({ percentage }: { percentage: number }) {
  return (
    <div className="h-1.5 w-full rounded-full bg-slate-100 overflow-hidden">
      <div
        className={cn(
          "h-full rounded-full transition-all duration-500 ease-out",
          percentage >= 100
            ? "bg-gradient-to-r from-emerald-500 to-emerald-400"
            : "bg-gradient-to-r from-blue-600 to-blue-400",
        )}
        style={{ width: `${Math.max(2, percentage)}%` }}
      />
    </div>
  )
}

// ─── Mobile Step Pill (horizontal scrolling) ───────────────────
function MobileStepPill({
  substep,
  index,
  isActive,
  onClick,
}: {
  substep: Substep
  index: number
  isActive: boolean
  onClick: () => void
}) {
  const navigable = isNavigable(substep)
  const isDone = substep.status === "complete"
  const isAction = substep.status === "action-required"
  const isLocked = !navigable

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={isLocked}
      className={cn(
        "relative flex flex-col items-center gap-1 shrink-0 px-1 min-w-[56px]",
        "transition-all duration-200",
        isLocked && "opacity-50 cursor-not-allowed",
        navigable && "cursor-pointer",
      )}
    >
      {/* Number circle */}
      <div
        className={cn(
          "flex h-8 w-8 items-center justify-center rounded-full text-[11px] font-bold",
          "border-2 transition-all duration-200",
          isDone && "bg-emerald-500 border-emerald-500 text-white",
          isActive && !isDone && "bg-blue-600 border-blue-600 text-white shadow-md shadow-blue-200",
          isAction && !isActive && "bg-amber-100 border-amber-400 text-amber-700",
          isLocked && "bg-slate-100 border-slate-200 text-slate-400",
          !isDone && !isActive && !isAction && !isLocked && "bg-white border-slate-200 text-slate-500",
        )}
      >
        {isDone ? (
          <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M13 4.5L6.5 11 3 7.5" />
          </svg>
        ) : (
          index + 1
        )}
      </div>
      {/* Label */}
      <span
        className={cn(
          "text-[9px] font-semibold leading-tight text-center max-w-[60px] line-clamp-2",
          isActive ? "text-blue-700" : isDone ? "text-emerald-700" : "text-slate-400",
        )}
      >
        {substep.title}
      </span>
    </button>
  )
}

// ─── Mobile Step Rail (connecting line between pills) ──────────
function MobileStepRail({
  substeps,
  currentId,
  onSelect,
}: {
  substeps: Substep[]
  currentId: string
  onSelect: (id: string) => void
}) {
  const scrollRef = React.useRef<HTMLDivElement>(null)

  React.useEffect(() => {
    const container = scrollRef.current
    if (!container) return
    const idx = substeps.findIndex((s) => s.id === currentId)
    const children = container.children
    if (idx >= 0 && children[idx]) {
      const child = children[idx] as HTMLElement
      const scrollTarget = child.offsetLeft - container.offsetWidth / 2 + child.offsetWidth / 2
      container.scrollTo({ left: Math.max(0, scrollTarget), behavior: "smooth" })
    }
  }, [currentId, substeps])

  return (
    <div className="relative">
      <div
        ref={scrollRef}
        className="flex items-end gap-0.5 overflow-x-auto scrollbar-none pb-1 px-2 snap-x snap-mandatory"
      >
        {substeps.map((substep, idx) => (
          <React.Fragment key={substep.id}>
            <div className="snap-center">
              <MobileStepPill
                substep={substep}
                index={idx}
                isActive={substep.id === currentId}
                onClick={() => {
                  if (isNavigable(substep)) onSelect(substep.id)
                }}
              />
            </div>
            {/* Connector line */}
            {idx < substeps.length - 1 && (
              <div className="flex items-center self-start mt-3.5 shrink-0">
                <div
                  className={cn(
                    "h-[2px] w-6 rounded-full",
                    substep.status === "complete" ? "bg-emerald-300" : "bg-slate-200",
                  )}
                />
              </div>
            )}
          </React.Fragment>
        ))}
      </div>
      {/* Fade edges */}
      <div className="pointer-events-none absolute inset-y-0 left-0 w-6 bg-gradient-to-r from-white to-transparent" />
      <div className="pointer-events-none absolute inset-y-0 right-0 w-6 bg-gradient-to-l from-white to-transparent" />
    </div>
  )
}

// ─── Detail Panel ──────────────────────────────────────────────
function DetailPanel({
  substep,
  onPrimaryAction,
  onSecondaryAction,
  onMarkComplete,
  onClose,
}: {
  substep: Substep
  onPrimaryAction?: () => void
  onSecondaryAction?: () => void
  onMarkComplete?: () => void
  onClose: () => void
}) {
  const isAction = substep.status === "action-required"
  const isWaiting = substep.status === "upcoming" || substep.status === "locked"
  const isDone = substep.status === "complete"

  return (
    <div
      className={cn(
        "rounded-2xl border bg-white shadow-sm overflow-hidden",
        "animate-in fade-in slide-in-from-top-1 duration-200",
        isAction && "border-amber-200",
        isDone && "border-emerald-200",
        !isAction && !isDone && "border-slate-200",
      )}
    >
      {/* Accent line */}
      <div
        className={cn(
          "h-[3px]",
          isAction
            ? "bg-gradient-to-r from-amber-400 to-orange-400"
            : isDone
              ? "bg-gradient-to-r from-emerald-500 to-emerald-400"
              : "bg-gradient-to-r from-blue-600 to-blue-400",
        )}
      />

      <div className="p-5">
        {/* Header */}
        <div className="flex items-start justify-between gap-3 mb-4">
          <div className="flex-1 min-w-0">
            <StatusBadge status={substep.status} className="mb-2" />
            <h3 className="text-lg font-extrabold text-slate-900 leading-tight">
              {substep.title}
            </h3>
            <p className="text-[13px] text-slate-500 font-medium mt-1 leading-relaxed">
              {substep.description}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="flex h-8 w-8 items-center justify-center rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-600 transition-colors shrink-0"
            aria-label="Close details"
          >
            <XIcon className="h-4 w-4" />
          </button>
        </div>

        {/* Warning */}
        {substep.warning && (
          <div className="flex items-start gap-3 rounded-xl bg-amber-50 border border-amber-200 p-3.5 mb-4">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-amber-100 shrink-0">
              <AlertTriangleIcon className="h-4 w-4 text-amber-600" />
            </div>
            <div>
              <p className="text-[13px] font-bold text-amber-800">Attention needed</p>
              <p className="text-[12px] text-amber-700 font-medium mt-0.5 leading-relaxed">
                {substep.warning}
              </p>
            </div>
          </div>
        )}

        {/* Info grid */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-4">
          {substep.gpAction && (
            <div className="rounded-xl bg-slate-50 border border-slate-200/80 p-3.5">
              <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1">
                Your Action
              </p>
              <p className="text-[13px] font-semibold text-slate-700 leading-relaxed">
                {substep.gpAction}
              </p>
            </div>
          )}
          {substep.estimatedTime && (
            <div className="rounded-xl bg-slate-50 border border-slate-200/80 p-3.5">
              <div className="flex items-center gap-1.5 mb-1">
                <ClockIcon className="h-3 w-3 text-slate-400" />
                <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">
                  Estimated Time
                </p>
              </div>
              <p className="text-[13px] font-semibold text-slate-700">{substep.estimatedTime}</p>
            </div>
          )}
          {substep.gpLinkAction && (
            <div className="rounded-xl bg-slate-50 border border-slate-200/80 p-3.5">
              <div className="flex items-center gap-1.5 mb-1">
                <ShieldCheckIcon className="h-3 w-3 text-slate-400" />
                <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wider">
                  GP Link Support
                </p>
              </div>
              <p className="text-[13px] font-semibold text-slate-700 leading-relaxed">
                {substep.gpLinkAction}
              </p>
            </div>
          )}
          {substep.helperText && (
            <div className="rounded-xl bg-slate-50 border border-slate-200/80 p-3.5">
              <p className="text-[10px] font-bold text-slate-400 uppercase tracking-wider mb-1">
                What Happens Next
              </p>
              <p className="text-[13px] font-semibold text-slate-700 leading-relaxed">
                {substep.helperText}
              </p>
            </div>
          )}
        </div>

        {/* Actions */}
        <div className="flex items-center gap-3 flex-wrap">
          {substep.primaryActionLabel && onPrimaryAction && (
            <button
              type="button"
              onClick={onPrimaryAction}
              className={cn(
                "inline-flex items-center gap-2 rounded-xl px-5 py-2.5",
                "text-[13px] font-bold transition-all duration-150",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/50",
                "bg-blue-600 text-white hover:bg-blue-700 shadow-sm hover:shadow-md hover:-translate-y-px",
              )}
            >
              {substep.primaryActionLabel}
              <ArrowRightIcon className="h-3.5 w-3.5" />
            </button>
          )}
          {substep.secondaryActionLabel && onSecondaryAction && (
            <button
              type="button"
              onClick={onSecondaryAction}
              className={cn(
                "inline-flex items-center gap-2 rounded-xl px-5 py-2.5",
                "text-[13px] font-bold border transition-all duration-150",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400/30",
                "bg-white text-slate-600 border-slate-200 hover:bg-slate-50 hover:border-slate-300",
              )}
            >
              {substep.secondaryActionLabel}
            </button>
          )}
          {!isDone && substep.status === "current" && onMarkComplete && (
            <button
              type="button"
              onClick={() => onMarkComplete()}
              className={cn(
                "inline-flex items-center gap-2 rounded-xl px-5 py-2.5",
                "text-[13px] font-bold border transition-all duration-150",
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400/30",
                "bg-white text-emerald-700 border-emerald-200 hover:bg-emerald-50",
              )}
            >
              Mark Complete
            </button>
          )}
        </div>
      </div>
    </div>
  )
}

// ─── Main Component ────────────────────────────────────────────
export function SubstepNavigation({
  substeps,
  currentSubstepId,
  onSubstepChange,
  onNext,
  onPrevious,
  onPrimaryAction,
  onSecondaryAction,
  onMarkComplete,
  workflowTitle,
  className,
}: SubstepNavigationProps) {
  const [selectedId, setSelectedId] = React.useState<string | null>(null)
  const progress = computeProgress(substeps, currentSubstepId)
  const canGoNext = !!getNextSubstep(substeps, currentSubstepId)
  const canGoPrev = !!getPreviousSubstep(substeps, currentSubstepId)
  const selectedSubstep = selectedId ? substeps.find((s) => s.id === selectedId) : null
  const currentSubstep = substeps.find((s) => s.id === currentSubstepId)

  const handleSelect = React.useCallback(
    (id: string) => {
      const substep = substeps.find((s) => s.id === id)
      if (!substep || !isNavigable(substep)) return

      if (selectedId === id) {
        setSelectedId(null)
      } else {
        setSelectedId(id)
        onSubstepChange?.(id)
      }
    },
    [substeps, selectedId, onSubstepChange],
  )

  const handleNext = React.useCallback(() => {
    if (onNext) {
      onNext()
    } else {
      const next = getNextSubstep(substeps, currentSubstepId)
      if (next) onSubstepChange?.(next.id)
    }
  }, [substeps, currentSubstepId, onNext, onSubstepChange])

  const handlePrev = React.useCallback(() => {
    if (onPrevious) {
      onPrevious()
    } else {
      const prev = getPreviousSubstep(substeps, currentSubstepId)
      if (prev) onSubstepChange?.(prev.id)
    }
  }, [substeps, currentSubstepId, onPrevious, onSubstepChange])

  return (
    <div className={cn("w-full", className)}>
      {/* ── Progress Header ── */}
      <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm mb-4">
        <div className="flex items-center justify-between gap-4 mb-3 flex-wrap">
          <div>
            {workflowTitle && (
              <p className="text-[11px] font-bold text-slate-400 uppercase tracking-wider mb-0.5">
                {workflowTitle}
              </p>
            )}
            <h2 className="text-lg font-extrabold text-slate-900">
              {currentSubstep?.title ?? "Getting Started"}
            </h2>
          </div>
          <div className="text-right shrink-0">
            <p className="text-2xl font-extrabold text-slate-900 tracking-tight">
              {progress.percentage}%
            </p>
            <p className="text-[12px] text-slate-500 font-medium">
              {progress.completedCount} of {progress.totalCount} complete
            </p>
          </div>
        </div>
        <ProgressBar percentage={progress.percentage} />
      </div>

      {/* ── Mobile Step Rail (visible below md) ── */}
      <div className="block md:hidden mb-4 rounded-2xl border border-slate-200 bg-white p-3 shadow-sm">
        <MobileStepRail
          substeps={substeps}
          currentId={selectedId ?? currentSubstepId}
          onSelect={handleSelect}
        />
      </div>

      {/* ── Detail Panel (when substep selected) ── */}
      {selectedSubstep && (
        <div className="mb-4">
          <DetailPanel
            substep={selectedSubstep}
            onPrimaryAction={
              onPrimaryAction ? () => onPrimaryAction(selectedSubstep.id) : undefined
            }
            onSecondaryAction={
              onSecondaryAction ? () => onSecondaryAction(selectedSubstep.id) : undefined
            }
            onMarkComplete={
              onMarkComplete ? () => onMarkComplete(selectedSubstep.id) : undefined
            }
            onClose={() => setSelectedId(null)}
          />
        </div>
      )}

      {/* ── Substep List (desktop: always visible, mobile: collapsible) ── */}
      <div className="space-y-2.5">
        {substeps.map((substep, idx) => (
          <SubstepCard
            key={substep.id}
            substep={substep}
            index={idx}
            isSelected={substep.id === (selectedId ?? currentSubstepId)}
            onClick={() => handleSelect(substep.id)}
          />
        ))}
      </div>

      {/* ── Navigation Controls ── */}
      <div className="flex items-center justify-between mt-5 gap-3">
        <button
          type="button"
          onClick={handlePrev}
          disabled={!canGoPrev}
          className={cn(
            "inline-flex items-center gap-2 rounded-xl px-4 py-2.5",
            "text-[13px] font-bold border transition-all duration-150",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-slate-400/30",
            canGoPrev
              ? "bg-white text-slate-600 border-slate-200 hover:bg-slate-50 hover:border-slate-300 cursor-pointer"
              : "bg-slate-50 text-slate-300 border-slate-100 cursor-not-allowed",
          )}
        >
          <ChevronLeftIcon className="h-4 w-4" />
          Previous
        </button>

        <p className="text-[12px] font-semibold text-slate-400 hidden sm:block">
          Step {progress.currentIndex + 1} of {progress.totalCount}
        </p>

        <button
          type="button"
          onClick={handleNext}
          disabled={!canGoNext}
          className={cn(
            "inline-flex items-center gap-2 rounded-xl px-4 py-2.5",
            "text-[13px] font-bold border transition-all duration-150",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/50",
            canGoNext
              ? "bg-blue-600 text-white border-blue-600 hover:bg-blue-700 shadow-sm cursor-pointer"
              : "bg-slate-50 text-slate-300 border-slate-100 cursor-not-allowed",
          )}
        >
          Next
          <ChevronRightIcon className="h-4 w-4" />
        </button>
      </div>
    </div>
  )
}
