import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import vm from 'node:vm'

const host = await import(`../lib/index.js?smoke=${Date.now()}`)
assert.equal(host.default.name, 'dsh-session-vault')
assert.equal(host.default.apply, host.apply)
assert.ok(host.default.inject.includes('storageDomain'))

let registration
const clientCode = await readFile(new URL('../lib/client.js', import.meta.url), 'utf8')
vm.runInNewContext(clientCode, {
  window: {
    __ModuleLoader__: {
      load(value) {
        registration = value
      },
    },
  },
  console,
  setTimeout,
  clearTimeout,
})

assert.equal(registration?.id, 'dsh-session-vault')
assert.equal(typeof registration?.factory, 'function')
const client = registration.factory((id) => {
  if (id === 'react' || id === 'react/jsx-runtime' || id === '@deepseek-ai/dsh-client-ui-primitives') return {}
  throw new Error(`客户端出现未声明的依赖：${id}`)
})
assert.equal(client.default.name, 'dsh-session-vault/client')
assert.equal(client.default.apply, client.apply)
assert.ok(client.default.inject.includes('slots'))

console.log('Host/Client 插件入口元数据有效')
