// The docs sidebar, in reading order. astro.config.mjs builds the navigation from it and llms.txt lists the pages in it.
export const sidebar = [
  {
    label: 'Start here',
    items: [
      { label: 'What is browserbay', slug: 'docs' },
      { label: 'Quick start', slug: 'docs/quick-start' },
      { label: 'Concepts', slug: 'docs/concepts' }
    ]
  },
  {
    label: 'Guides',
    items: [
      { label: 'Drive a browser', slug: 'docs/guides/drive-a-browser' },
      { label: 'Live view', slug: 'docs/guides/live-view' },
      { label: 'Hand off and clean up', slug: 'docs/guides/hand-off' },
      { label: 'Share one box', slug: 'docs/guides/share-a-box' }
    ]
  },
  {
    label: 'Deploy',
    items: [
      { label: 'All-in-one', slug: 'docs/deploy/all-in-one' },
      { label: 'Relay and nodes', slug: 'docs/deploy/split' },
      { label: 'Kubernetes', slug: 'docs/deploy/kubernetes' },
      { label: 'Configuration', slug: 'docs/deploy/configuration' }
    ]
  },
  {
    label: 'Reference',
    items: [
      { label: 'Node client', slug: 'docs/reference/client' },
      { label: 'Python client', slug: 'docs/reference/python' },
      { label: 'Go client', slug: 'docs/reference/go' },
      { label: 'HTTP API', slug: 'docs/reference/http-api' },
      { label: 'CLI', slug: 'docs/reference/cli' }
    ]
  },
  {
    label: 'Run it well',
    items: [
      { label: 'Trust and isolation', slug: 'docs/security/trust' },
      { label: 'Operations', slug: 'docs/security/operations' },
      { label: 'Limits', slug: 'docs/security/limits' }
    ]
  }
]
