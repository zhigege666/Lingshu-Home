import { request } from '../core/api'
import { isLinkActivation, type LinkClickEntry } from '../core/link-clicks'

export function recordLinkClick(spaceId: string | undefined, linkId: string, entry: LinkClickEntry, event: { type: string; button: number; defaultPrevented: boolean }, inactive: boolean) {
  if (inactive || !spaceId || !isLinkActivation(event)) return
  // getRandomValues also works on ordinary HTTP installations. One ID per
  // activation prevents duplicate delivery from increasing the count twice.
  const bytes = crypto.getRandomValues(new Uint8Array(16))
  bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128
  const hex = [...bytes].map(value => value.toString(16).padStart(2, '0')).join('')
  const eventId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
  // A statistics failure never blocks the destination or triggers a retry.
  // Keepalive covers same-tab modified clicks and page teardown.
  void request(`/spaces/${encodeURIComponent(spaceId)}/links/${encodeURIComponent(linkId)}/clicks`, {
    method: 'POST', body: { eventId, entry }, keepalive: true
  }).catch(() => {})
}
