import { contextBridge, ipcRenderer } from 'electron'
import {
  API_METHODS,
  channelName,
  FLUSH_REQUEST_CHANNEL,
  RUN_EVENT_CHANNEL,
  unwrapIpcError,
  type AstralApi,
  type AstralEvents
} from '../shared/api'
import type { RunEvent } from '../shared/types'

/** Built from the same method table the main process registers handlers from. */
function buildApi(): AstralApi {
  const api: Record<string, Record<string, (...args: unknown[]) => Promise<unknown>>> = {}
  for (const [group, methods] of Object.entries(API_METHODS)) {
    api[group] = {}
    for (const method of methods) {
      api[group][method] = async (...args) => {
        try {
          return await ipcRenderer.invoke(channelName(group, method), ...args)
        } catch (e) {
          throw unwrapIpcError(e)
        }
      }
    }
  }
  return api as unknown as AstralApi
}

const events: AstralEvents = {
  onFlushRequest(listener) {
    // The IPC event object is not passed on: the renderer gets no handle on ipcRenderer.
    const handler = (): void => listener()
    ipcRenderer.on(FLUSH_REQUEST_CHANNEL, handler)
    return () => {
      ipcRenderer.removeListener(FLUSH_REQUEST_CHANNEL, handler)
    }
  },
  onRunEvent(listener) {
    const handler = (_event: Electron.IpcRendererEvent, runEvent: RunEvent): void => listener(runEvent)
    ipcRenderer.on(RUN_EVENT_CHANNEL, handler)
    return () => {
      ipcRenderer.removeListener(RUN_EVENT_CHANNEL, handler)
    }
  }
}

contextBridge.exposeInMainWorld('astral', buildApi())
contextBridge.exposeInMainWorld('astralEvents', events)
