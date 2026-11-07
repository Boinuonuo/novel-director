import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => '/app-data', setPath: vi.fn(), commandLine: { hasSwitch: () => true } },
}))

import { pinUserDataPath } from './stable-user-data'

const host = (hasDataDirSwitch: boolean) => ({
  getPath: vi.fn(() => '/app-data'),
  setPath: vi.fn(),
  commandLine: { hasSwitch: () => hasDataDirSwitch },
})

describe('pinUserDataPath', () => {
  it('keeps the data folder the app has always used', () => {
    const app = host(false)
    pinUserDataPath(app)
    expect(app.setPath).toHaveBeenCalledWith('userData', path.join('/app-data', 'novel-chatbox'))
  })

  it('leaves an explicit --user-data-dir alone', () => {
    const app = host(true)
    pinUserDataPath(app)
    expect(app.setPath).not.toHaveBeenCalled()
  })
})
