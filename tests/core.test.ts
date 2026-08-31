import { describe, expect, it } from 'vitest'
import {
  assertUniqueTrashPaths,
  isLoopbackHost,
  isLoopbackRemoteAddress,
  isPathInside,
  isSessionId,
  normalizeIds,
  retainedSessionIds,
  selectOrphanedIds,
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

describe('孤儿状态对账', () => {
  it('只挑出现存会话之外的标识', () => {
    const known = new Set(['session-a', 'session-b'])
    expect(selectOrphanedIds(['session-a', 'session-x', 'session-b', 'session-y'], known))
      .toEqual(['session-x', 'session-y'])
  })

  it('全部标识都有对应会话时不产生清理项', () => {
    const known = new Set(['session-a', 'session-b'])
    expect(selectOrphanedIds(['session-a', 'session-b'], known)).toEqual([])
  })

  it('空的会话集合会让全部标识成为孤儿——因此调用方必须保证列举成功', () => {
    // 记录该边界语义：本函数不区分「确实没有会话」与「列举失败」，
    // 后者必须由调用方在传入前抛出，绝不能退化成空集合传进来。
    expect(selectOrphanedIds(['session-a'], new Set())).toEqual(['session-a'])
  })
})

describe('回收站会话不得被当作孤儿', () => {
  it('把回收站中的会话并入保留集合', () => {
    const retained = retainedSessionIds(['session-a'], ['session-t'])
    expect([...retained].sort()).toEqual(['session-a', 'session-t'])
  })

  it('移入回收站的会话不会被判为孤儿', () => {
    // 回归防护：会话移入回收站后已不在 sessions 目录，若不并入保留集合，
    // 对账会清掉用于遮蔽它的归档标记，导致它重新出现在侧边栏。
    const existing = ['session-a']
    const trashed = ['session-t']
    const known = retainedSessionIds(existing, trashed)
    expect(selectOrphanedIds(['session-a', 'session-t'], known)).toEqual([])
  })

  it('既不存在也不在回收站的标识仍会被清理', () => {
    const known = retainedSessionIds(['session-a'], ['session-t'])
    expect(selectOrphanedIds(['session-a', 'session-t', 'session-x'], known)).toEqual(['session-x'])
  })
})
