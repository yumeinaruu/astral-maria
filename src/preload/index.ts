import { contextBridge, ipcRenderer } from 'electron'
import { API_METHODS, channelName, unwrapIpcError, type AstralApi } from '../shared/api'

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

contextBridge.exposeInMainWorld('astral', buildApi())
