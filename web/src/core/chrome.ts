import type { PageChrome } from './types'

export function defaultPageChrome(): PageChrome {
  return {
    header: { enabled: false, left: [], center: [], right: [] },
    footer: { enabled: true, left: [], center: [], right: [{ id: 'home-branding', type: 'branding' }] }
  }
}

export function readPageChrome(chrome?: PageChrome): PageChrome {
  return chrome ? structuredClone(chrome) : defaultPageChrome()
}
