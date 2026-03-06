"use client"

import { cn } from "@/lib/utils"
import type { SubstepStatus } from "@/types/registration"

const statusConfig: Record<SubstepStatus, { label: string; className: string }> = {
  current: {
    label: "In Progress",
    className: "bg-blue-50 text-blue-700 border-blue-200",
  },
  complete: {
    label: "Complete",
    className: "bg-emerald-50 text-emerald-700 border-emerald-200",
  },
  upcoming: {
    label: "Upcoming",
    className: "bg-slate-50 text-slate-500 border-slate-200",
  },
  locked: {
    label: "Locked",
    className: "bg-slate-50 text-slate-400 border-slate-200",
  },
  "action-required": {
    label: "Action Required",
    className: "bg-amber-50 text-amber-700 border-amber-200",
  },
}

interface StatusBadgeProps {
  status: SubstepStatus
  className?: string
}

export function StatusBadge({ status, className }: StatusBadgeProps) {
  const config = statusConfig[status]

  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full border px-2.5 py-0.5",
        "text-[10px] font-bold uppercase tracking-wide",
        "select-none whitespace-nowrap",
        config.className,
        className,
      )}
    >
      {config.label}
    </span>
  )
}
