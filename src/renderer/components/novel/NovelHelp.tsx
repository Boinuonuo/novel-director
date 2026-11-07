import { IconHelpCircle } from '@tabler/icons-react'
import { ScalableIcon } from '@/components/common/ScalableIcon'
import { AppTooltip as Tooltip } from '@/components/ui/tooltip'

/** A quiet "?" that explains something on hover, instead of permanent helper text. */
export function NovelHelp({ label }: { label: string }) {
  return (
    <Tooltip label={label} multiline w={260} withArrow>
      <span className="inline-flex cursor-help align-middle" aria-label={label}>
        <ScalableIcon icon={IconHelpCircle} size={15} className="text-chatbox-tint-tertiary" />
      </span>
    </Tooltip>
  )
}
