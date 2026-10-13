// Docs pages link to each other with root-relative paths like /docs/quick-start/. When the site is deployed under a
// subpath (GitHub Pages project sites), those links need the base in front. With base "/" this does nothing.
// Handles links, images, definitions, JSX href/src attributes and raw HTML href/src attributes.
export default function remarkBase({ base = '/' } = {}) {
  const segment = base.replace(/^\/+|\/+$/g, '')
  const prefix = segment ? `/${segment}` : ''

  const needsPrefix = (url) =>
    typeof url === 'string' &&
    url.startsWith('/') &&
    !url.startsWith('//') &&
    url !== prefix &&
    !url.startsWith(`${prefix}/`)
  const fix = (url) => (needsPrefix(url) ? prefix + url : url)

  const walk = (node) => {
    if (node.type === 'link' || node.type === 'image' || node.type === 'definition') node.url = fix(node.url)
    if (node.type === 'html' && typeof node.value === 'string') {
      node.value = node.value.replace(/\b(href|src)="(\/[^"]*)"/g, (_, name, url) => `${name}="${fix(url)}"`)
    }
    for (const attribute of node.attributes ?? []) {
      if ((attribute.name === 'href' || attribute.name === 'src') && typeof attribute.value === 'string') {
        attribute.value = fix(attribute.value)
      }
    }
    node.children?.forEach(walk)
  }

  return (tree) => {
    if (prefix) walk(tree)
  }
}
