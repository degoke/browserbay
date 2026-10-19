import assert from 'node:assert/strict'
import test from 'node:test'
import { isForbiddenIp, isForbiddenProxyHost, parseProxyServer, proxyRulesAllowed } from './proxy-address.js'

test('a proxy server is scheme://host:port and nothing else', () => {
  assert.deepEqual(parseProxyServer('http://proxy.example.com:8080'), {
    scheme: 'http',
    host: 'proxy.example.com',
    port: 8080
  })
  assert.deepEqual(parseProxyServer('https://p.example:443'), { scheme: 'https', host: 'p.example', port: 443 })
  assert.deepEqual(parseProxyServer('socks5://10.0.0.7:1080'), { scheme: 'socks5', host: '10.0.0.7', port: 1080 })
  assert.deepEqual(parseProxyServer('socks5://[2001:db8::1]:1080'), {
    scheme: 'socks5',
    host: '2001:db8::1',
    port: 1080
  })
  assert.deepEqual(parseProxyServer('http://proxy_1.internal:3128'), {
    scheme: 'http',
    host: 'proxy_1.internal',
    port: 3128
  })

  for (const bad of [
    'proxy.example.com:8080', // no scheme
    'http://proxy.example.com', // no port: the default is not guessed
    'http://user:pass@proxy.example.com:8080', // credentials have their own fields, and must not travel in a URL
    'http://proxy.example.com:8080/', // no path
    'http://proxy.example.com:8080?x=1',
    'http://proxy.example.com:0',
    'http://proxy.example.com:65536',
    'http://proxy.example.com:99999',
    'socks4://proxy.example.com:1080', // the schemes are the three the forwarder speaks
    'socks5h://proxy.example.com:1080',
    'ftp://proxy.example.com:21',
    'http://:8080',
    'http://-bad.example.com:8080',
    'http://has space.example.com:8080',
    `http://${'a'.repeat(300)}.example.com:8080`,
    '',
    ' http://proxy.example.com:8080'
  ]) {
    assert.equal(parseProxyServer(bad), undefined, JSON.stringify(bad))
  }
  for (const notText of [undefined, null, 8080, {}, ['http://p.example:1']])
    assert.equal(parseProxyServer(notText), undefined)
})

test('loopback, unspecified and link-local are refused however they are spelled', () => {
  for (const host of [
    'localhost',
    'LOCALHOST',
    'localhost.',
    'app.localhost',
    'ip6-localhost',
    'ip6-loopback',
    '127.0.0.1',
    '127.1',
    '127.255.255.254',
    '0x7f000001', // hexadecimal
    '2130706433', // one decimal number
    '0177.0.0.1', // octal
    '0',
    '0.0.0.0',
    '0.1.2.3',
    '169.254.169.254', // the cloud metadata address
    '169.254.0.1',
    '::',
    '::1',
    '[::1]',
    '0:0:0:0:0:0:0:1',
    '::ffff:127.0.0.1', // IPv4 in IPv6 clothes
    '::ffff:7f00:1',
    '::ffff:169.254.169.254',
    '::127.0.0.1',
    '64:ff9b::7f00:1', // NAT64 to loopback
    'fe80::1',
    'febf::1',
    '[fe80::1%eth0]'
  ]) {
    assert.ok(isForbiddenProxyHost(host), `${host} is this machine or its link`)
  }
})

test('ordinary and private proxy addresses are allowed', () => {
  for (const host of [
    'proxy.example.com',
    'localhost.example.com',
    'notlocalhost',
    '8.8.8.8',
    '10.0.0.1',
    '172.16.5.4',
    '192.168.1.1',
    '100.64.0.1', // Tailscale, carrier-grade NAT
    '169.253.1.1',
    '128.0.0.1',
    '2001:db8::1',
    'fec0::1', // not fe80::/10
    '::ffff:8.8.8.8',
    'fd00::1' // unique local: a private network
  ]) {
    assert.ok(!isForbiddenProxyHost(host), `${host} is somewhere a proxy may be`)
  }
})

test('an address a name resolved to is judged as an address', () => {
  assert.ok(isForbiddenIp('127.0.0.1'))
  assert.ok(isForbiddenIp('::1'))
  assert.ok(isForbiddenIp('::ffff:127.0.0.1'))
  assert.ok(isForbiddenIp('169.254.169.254'))
  assert.ok(!isForbiddenIp('93.184.216.34'))
  assert.ok(!isForbiddenIp('example.com'), 'a name is not an address: the caller resolves it first')
  assert.ok(!isForbiddenIp('999.1.1.1'))
})

test('proxy rules are allowed only when every host in them is', () => {
  for (const rules of [
    '203.0.113.5:8080',
    'http://203.0.113.5:8080',
    'socks5://10.0.0.7:1080',
    'http=203.0.113.5:80;https=198.51.100.9:443',
    '203.0.113.5:1,198.51.100.9:2',
    'direct://',
    'http://203.0.113.5:8080,direct://',
    '[2001:db8::1]:8080',
    ''
  ]) {
    assert.ok(proxyRulesAllowed(rules), rules)
  }
  for (const rules of [
    '127.0.0.1:8080',
    'http://127.0.0.1:8080',
    'socks5://localhost:1080',
    'http=203.0.113.5:80;https=127.0.0.1:443', // one bad host spoils the whole rule
    '203.0.113.5:1,127.1:2',
    '203.0.113.5:8080,[::1]:9',
    'http://user@203.0.113.5:8080', // credentials in a rule are not a thing Chromium reads
    'http://203.0.113.5:8080/path',
    'proxy.example.com:8080', // a name: Chromium resolves it, and it can point at loopback
    'http://127.0.0.1.nip.io:8080',
    'socks5://localtest.me:1080',
    '0x7f000001:80',
    '169.254.169.254:80',
    'http://[::ffff:7f00:1]:80'
  ]) {
    assert.ok(!proxyRulesAllowed(rules), rules)
  }
})
