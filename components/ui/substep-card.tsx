"use client"

import { cn } from "@/lib/utils"
import type { Substep, SubstepStatus } from "@/types/registration"
import { StatusBadge } from "@/components/ui/status-badge"
import {
  CheckIcon,
  LockIcon,
  AlertTriangleIcon,
  Loader2Icon,
  CircleDotIcon,
  CircleIcon,
  ChevronRightIcon,
} from "lucide-react"

interface SubstepCardProps {
  substep: Substep
  index: number
  isSelected: boolean
  onClick: () => void
}

function StepIcon({ status }: { status: SubstepStatus }) {
  const base = "flex h-9 w-9 items-center justify-center rounded-xl shrink-0 transition-colors duration-200"

  switch (status) {
    case "complete":
      return (
        <div className={cn(base, "bg-emerald-50 text-emerald-600")}>
          <CheckIcon className="h-[18px] w-[18px]" strokeWidth={2.5} />
        </div>
      )
    case "current":
      return (
        <div className={cn(base, "bg-blue-50 text-blue-600")}>
          <CircleDotIcon className="h-[18px] w-[18px]" strokeWidth={2} />
        </div>
      )
    case "action-required":
      return (
        <div className={cn(base, "bg-amber-50 text-amber-600")}>
          <AlertTriangleIcon className="h-[18px] w-[18px]" strokeWidth={2} />
        </div>
      )
    case "locked":
      return (
        <div className={cn(base, "bg-slate-100 text-slate-400")}>
          <LockIcon className="h-[16px] w-[16px]" strokeWidth={2} />
        </div>
      )
    case "upcoming":
      return (
        <div className={cn(base, "bg-slate-50 text-slate-400")}>
          <CircleIcon className="h-[16px] w-[16px]" strokeWidth={2} />
        </div>
      )
  }
}

export function SubstepCard({ substep, index, isSelected, onClick }: SubstepCardProps) {
  const navigable = substep.status !== "locked" && !substep.locked
  const isCurrent = substep.status === "current"
  const isDone = substep.status === "complete"
  const isAction = substep.status === "action-required"
  const isLocked = substep.status === "locked" || substep.locked

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={isLocked}
      className={cn(
        "group relative w-full text-left",
        "flex items-center gap-3.5 rounded-2xl border p-4",
        "transition-all duration-200",
        // Base
        "bg-white border-slate-200/80",
        // Hover
        navigable && "cursor-pointer hover:border-slate-300 hover:shadow-sm hover:-translate-y-px",
        // Selected
        isSelected && isCurrent && "border-blue-300 bg-blue-50/40 shadow-sm",
        isSelected && isDone && "border-emerald-200 bg-emerald-50/30 shadow-sm",
        isSelected && isAction && "border-amber-200 bg-amber-50/30 shadow-sm",
        // Status variants (not selected)
        !isSelected && isCurrent && "border-blue-200/60 bg-gradient-to-r from-blue-50/30 to-white",
        !isSelected && isDone && "border-emerald-200/50",
        !isSelected && isAction && "border-amber-200/60 bg-gradient-to-r from-amber-50/20 to-white",
        // Locked
        isLocked && "opacity-60 cursor-not-allowed hover:translate-y-0 hover:shadow-none",
      )}
    >
      <StepIcon status={substep.status} />

      <div className="flex-1 min-w-0">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="text-[11px] font-semibold text-slate-400 uppercase tracking-wide">
            Step {index + 1}
          </span>
          {substep.optional && (
            <span className="text-[10px] font-medium text-slate-400 italic">Optional</span>
          )}
        </div>
        <p className={cn(
          "text-[14px] font-bold leading-tight mt-0.5",
          isLocked ? "text-slate-400" : "text-slate-800",
        )}>
          {substep.title}
        </p>
        <p className={cn(
          "text-[12px] mt-0.5 line-clamp-1",
          isLocked ? "text-slate-400" : "text-slate-500",
        )}>
          {substep.description}
        </p>
      </div>

      <div className="flex items-center gap-2 shrink-0">
        <StatusBadge status={substep.status} />
        {navigable && (
          <ChevronRightIcon className="h-4 w-4 text-slate-400 transition-transform group-hover:translate-x-0.5" />
        )}
      </div>
    </button>
  )
}
