import { useComputedColorScheme } from '@mantine/core'
import type * as React from 'react'

function HomepageIcon(props: React.SVGProps<SVGSVGElement>) {
  const colorScheme = useComputedColorScheme()
  const isDark = colorScheme === 'dark'
  const fillColor = isDark ? '#7D90A1' : '#EDF0F2'
  const strokeColor = isDark ? '#45525F' : '#899AA9'

  return (
    <svg width={36} height={32} viewBox="0 0 36 32" fill="none" {...props}>
      <path
        d="M18 6.5C14.8 3.9 9.7 3.1 4.4 3.9 3.5 4 3 4.7 3 5.5v19.2c0 1 .9 1.8 1.9 1.6 4.9-.8 9.8-.2 13.1 2.7V6.5z"
        fill={fillColor}
        stroke={strokeColor}
        strokeWidth={2}
        strokeLinejoin="round"
      />
      <path
        d="M18 6.5c3.2-2.6 8.3-3.4 13.6-2.6.9.1 1.4.8 1.4 1.6v19.2c0 1-.9 1.8-1.9 1.6-4.9-.8-9.8-.2-13.1 2.7V6.5z"
        fill={fillColor}
        stroke={strokeColor}
        strokeWidth={2}
        strokeLinejoin="round"
      />
    </svg>
  )
}

export default HomepageIcon
