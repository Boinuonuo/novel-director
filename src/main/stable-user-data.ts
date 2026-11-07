import path from 'node:path'
import { app } from 'electron'

/**
 * The app used to be called this, and Electron names the data folder after the app.
 * Pinning the folder keeps every novel and setting where it is across a rename.
 */
export const USER_DATA_FOLDER = 'novel-chatbox'

type PathsHost = Pick<typeof app, 'getPath' | 'setPath'> & {
  commandLine: Pick<typeof app.commandLine, 'hasSwitch'>
}

export function pinUserDataPath(host: PathsHost): void {
  if (host.commandLine.hasSwitch('user-data-dir')) return
  host.setPath('userData', path.join(host.getPath('appData'), USER_DATA_FOLDER))
}

pinUserDataPath(app)
