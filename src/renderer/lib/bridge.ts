import type { Bridge } from '../../shared/bridge'

declare global {
  interface Window {
    openapplyr: Bridge
  }
}

export const bridge: Bridge = window.openapplyr
