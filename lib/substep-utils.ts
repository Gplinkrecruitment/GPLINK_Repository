import type { Substep, SubstepStatus, WorkflowProgress } from "@/types/registration"

/** Compute progress stats from a list of substeps */
export function computeProgress(substeps: Substep[], currentId: string): WorkflowProgress {
  const completedCount = substeps.filter((s) => s.status === "complete").length
  const totalCount = substeps.length
  const percentage = totalCount > 0 ? Math.round((completedCount / totalCount) * 100) : 0
  const currentIndex = Math.max(0, substeps.findIndex((s) => s.id === currentId))

  return { completedCount, totalCount, percentage, currentIndex }
}

/** Check if a substep can be navigated to */
export function isNavigable(substep: Substep): boolean {
  if (substep.locked) return false
  if (substep.status === "locked") return false
  return true
}

/** Get the next navigable substep, or null */
export function getNextSubstep(substeps: Substep[], currentId: string): Substep | null {
  const idx = substeps.findIndex((s) => s.id === currentId)
  if (idx === -1 || idx >= substeps.length - 1) return null
  const next = substeps[idx + 1]
  return isNavigable(next) ? next : null
}

/** Get the previous navigable substep, or null */
export function getPreviousSubstep(substeps: Substep[], currentId: string): Substep | null {
  const idx = substeps.findIndex((s) => s.id === currentId)
  if (idx <= 0) return null
  const prev = substeps[idx - 1]
  return isNavigable(prev) ? prev : null
}

/** Human-readable label for a status */
export function statusLabel(status: SubstepStatus): string {
  switch (status) {
    case "current":
      return "In Progress"
    case "complete":
      return "Complete"
    case "upcoming":
      return "Upcoming"
    case "locked":
      return "Locked"
    case "action-required":
      return "Action Required"
  }
}
