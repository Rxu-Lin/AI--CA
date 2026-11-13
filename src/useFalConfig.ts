import { useEffect, useSyncExternalStore } from 'react'
import { getFalConfig, loadFalServerConfig, subscribeFalConfig } from './falConfig'

export function useFalConfig() {
  const config = useSyncExternalStore(subscribeFalConfig, getFalConfig, getFalConfig)
  useEffect(() => { void loadFalServerConfig() }, [])
  return config
}
