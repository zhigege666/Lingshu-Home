const navigationEvent = 'lingshu:before-navigation'
/** Runs navigation immediately unless the active editor preserves an unsaved draft. */
export function requestNavigation(proceed: () => void): boolean {
  const event = new CustomEvent(navigationEvent, { cancelable: true, detail: { proceed } })
  window.dispatchEvent(event)
  if (event.defaultPrevented) return false
  proceed(); return true
}
export const beforeNavigationEvent = navigationEvent
export const routeCommittedEvent = 'lingshu:route-committed'
/** Announce an already-approved replaceState route change to the app router. */
export function notifyRouteCommitted() { window.dispatchEvent(new Event(routeCommittedEvent)) }
