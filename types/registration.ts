/** Status values for a substep in a registration workflow */
export type SubstepStatus =
  | "current"
  | "complete"
  | "upcoming"
  | "locked"
  | "action-required"

/** A single substep within a registration workflow page */
export interface Substep {
  id: string
  title: string
  description: string
  status: SubstepStatus
  /** Prevents navigation into this substep */
  locked?: boolean
  /** Whether this substep has been completed */
  completed?: boolean
  /** Whether this substep requires user attention */
  actionRequired?: boolean
  /** Whether this substep is optional */
  optional?: boolean
  /** Additional context shown in the detail panel */
  helperText?: string
  /** What the GP needs to do for this substep */
  gpAction?: string
  /** What GP Link is handling for this substep */
  gpLinkAction?: string
  /** Estimated time to complete */
  estimatedTime?: string
  /** Warning or blocker message */
  warning?: string
  /** Label for the primary action button */
  primaryActionLabel?: string
  /** Label for the secondary action button */
  secondaryActionLabel?: string
}

/** Props for the SubstepNavigation component */
export interface SubstepNavigationProps {
  /** Ordered list of substeps */
  substeps: Substep[]
  /** ID of the currently active substep */
  currentSubstepId: string
  /** Called when user navigates to a different substep */
  onSubstepChange?: (substepId: string) => void
  /** Called when user clicks "Next" */
  onNext?: () => void
  /** Called when user clicks "Previous" */
  onPrevious?: () => void
  /** Called when user clicks the primary action button */
  onPrimaryAction?: (substepId: string) => void
  /** Called when user clicks the secondary action button */
  onSecondaryAction?: (substepId: string) => void
  /** Called when user clicks "Mark Complete" */
  onMarkComplete?: (substepId: string) => void
  /** Title of the parent registration step (e.g. "MyIntealth") */
  workflowTitle?: string
  /** Additional CSS class */
  className?: string
}

/** Computed progress data for a workflow */
export interface WorkflowProgress {
  completedCount: number
  totalCount: number
  percentage: number
  currentIndex: number
}
