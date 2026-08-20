import { describe, expect, it } from 'vitest'
import {
  assertUniqueTrashPaths,
  isLoopbackHost,
  isLoopbackRemoteAddress,
  isPathInside,
  isSessionId,
  normalizeIds,
  sessionDirectoryFromArtifact,
} from '../src/core.js'

describe('会话标识校验', () => {
  it('接受 DSH 常见会话标识', () => {
    expect(isSessionId('session-71c6afdf-8017-40cd-ac72-666201bb4b9e')).toBe(true)
    expect(isSessionId('71c6afdf-8017-40cd-ac72-666201bb4b9e')).toBe(true)
  })

  it('拒绝路径和空值', () => {
    expect(isSessionId('../workspace.json')).toBe(false)
    expect(isSessionId('')).toBe(false)
  })

  it('批量标识去重并丢弃非法项', () => {
    expect(normalizeIds(['session-a', 'session-a', '../x', 7])).toEqual(['session-a'])
  })
})

describe('文件系统围栏', () => {
  it('只允许 sessions 根目录下的子路径', () => {
    expect(isPathInside('/home/u/.dsh/sessions', '/home/u/.dsh/sessions/a/session-x')).toBe(true)
    expect(isPathInside('/home/u/.dsh/sessions', '/home/u/.dsh/workspace.json')).toBe(false)
    expect(isPathInside('/home/u/.dsh/sessions', '/home/u/.dsh/sessions')).toBe(false)
  })

  it('从记录文件安全解析会话目录', () => {
    expect(sessionDirectoryFromArtifact('/home/u/.dsh/sessions', '/home/u/.dsh/sessions/p/session-a/session.jsonl.zstd'))
      .toBe('/home/u/.dsh/sessions/p/session-a')
    expect(() => sessionDirectoryFromArtifact('/home/u/.dsh/sessions', '/tmp/session.jsonl')).toThrow()
  })
})

describe('本机请求识别', () => {
  it('接受 IPv4、IPv6 和 IPv4 映射地址', () => {
    expect(isLoopbackHost('localhost')).toBe(true)
    expect(isLoopbackHost('127.0.0.42')).toBe(true)
    expect(isLoopbackRemoteAddress('::1')).toBe(true)
    expect(isLoopbackRemoteAddress('::ffff:127.0.0.1')).toBe(true)
  })

  it('拒绝非回环地址和伪造的远端 localhost', () => {
    expect(isLoopbackHost('192.168.1.20')).toBe(false)
    expect(isLoopbackRemoteAddress('192.168.1.20')).toBe(false)
    expect(isLoopbackRemoteAddress('localhost')).toBe(false)
    expect(isLoopbackRemoteAddress(undefined)).toBe(false)
  })
})

describe('回收站状态', () => {
  it('拒绝重复标识或路径', () => {
    expect(() => assertUniqueTrashPaths([
      { sessionId: 'session-a', trashPath: '/trash/a' },
      { sessionId: 'session-a', trashPath: '/trash/b' },
    ])).toThrow('重复会话')
  })
})
