import NiceModal from '@ebay/nice-modal-react'
import ArtifactPreview from './ArtifactPreview'
import ClearSessionList from './ClearSessionList'
import ConfirmModal from './ConfirmModal'
import ContentViewer from './ContentViewer'
import ExportChat from './ExportChat'
import FileParseError from './FileParseError'
import JsonViewer from './JsonViewer'
import MessageEdit from './MessageEdit'
import ModelEdit from './ModelEdit'
import SessionFolderCreate from './SessionFolderCreate'
import SessionFolderMove from './SessionFolderMove'
import SessionFolderName from './SessionFolderName'
import SessionSettings from './SessionSettings'
import ThreadNameEdit from './ThreadNameEdit'

NiceModal.register('file-parse-error', FileParseError)
NiceModal.register('content-viewer', ContentViewer)
NiceModal.register('session-settings', SessionSettings)
NiceModal.register('artifact-preview', ArtifactPreview)
NiceModal.register('clear-session-list', ClearSessionList)
NiceModal.register('session-folder-create', SessionFolderCreate)
NiceModal.register('session-folder-name', SessionFolderName)
NiceModal.register('session-folder-move', SessionFolderMove)
NiceModal.register('confirm', ConfirmModal)
NiceModal.register('export-chat', ExportChat)
NiceModal.register('message-edit', MessageEdit)
NiceModal.register('json-viewer', JsonViewer)
NiceModal.register('model-edit', ModelEdit)
NiceModal.register('thread-name-edit', ThreadNameEdit)
