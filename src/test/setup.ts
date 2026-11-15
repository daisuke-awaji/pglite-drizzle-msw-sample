// expect に toBeInTheDocument などを足す（副作用だけの import）
// oxlint-disable-next-line import/no-unassigned-import
import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach, beforeEach } from 'vitest'
import { usePreferences } from '../stores/preferences'
import { installConsoleGuard } from './console'

declare global {
  var __UI_SDK_STRICT__: boolean | undefined
}
globalThis.__UI_SDK_STRICT__ = true

installConsoleGuard()

// 端末の設定・下書きはテストごとに初期状態へ戻す（前のテストの設定が漏れないように）
const initialPreferences = usePreferences.getState()
beforeEach(() => {
  usePreferences.setState(initialPreferences, true)
  if (typeof localStorage !== 'undefined') localStorage.clear()
  if (typeof sessionStorage !== 'undefined') sessionStorage.clear()
})

// jsdom にない API の代わり（UI SDK のテストガイドどおり）
if (typeof document !== 'undefined') {
  HTMLElement.prototype.showPopover = function () {}
  HTMLElement.prototype.hidePopover = function () {}
  Element.prototype.getAnimations = () => []
  Element.prototype.scrollIntoView = function () {}
  Element.prototype.checkVisibility = () => true
  Element.prototype.getClientRects = () => [] as unknown as DOMRectList
  document.elementFromPoint = () => null
  document.elementsFromPoint = () => []
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
  window.matchMedia ??= (query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener() {},
      removeEventListener() {},
      addListener() {},
      removeListener() {},
      dispatchEvent: () => false,
    }) as MediaQueryList
  document.head.append(
    Object.assign(document.createElement('style'), {
      textContent: '[popover] { display: block !important }',
    }),
  )
  afterEach(cleanup)
}
