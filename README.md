# DSH Session Vault

[中文](README.md) · [English](README.en.md)

一个面向 **DeepSeek Harness（DSH）`0.1.1-rc.2`** 的开源会话管理插件。它把活动会话、归档会话和回收站集中到一个设置页中，提供可恢复的删除流程，同时不注册模型工具、不修改 Router preset，也不注入网页 DOM。

> **默认语言：中文**　[切换到 English](README.en.md)

## 目录

- [功能特点](#功能特点)
- [兼容性](#兼容性)
- [安装](#安装)
- [使用方法](#使用方法)
- [数据与安全](#数据与安全)
- [故障排查](#故障排查)
- [开发与测试](#开发与测试)
- [项目结构](#项目结构)
- [许可证](#许可证)

## 功能特点

### 1. 三类会话统一管理

在 **设置 → 会话保险库** 中提供三个标签页：

- **活动**：当前未归档的会话；
- **归档**：被隐藏但仍然保留的会话；
- **回收站**：已经移出主会话目录、但仍可恢复的会话。

### 2. 搜索与批量操作

可按标题、会话 ID 或工作目录搜索，并对当前筛选结果执行批量归档、取消归档、移入回收站、恢复或永久清除。正在运行的会话会被标记并禁止危险操作。

### 3. 可恢复的删除流程

“移入回收站”不是立即销毁：插件会把 DSH 自己的会话记录目录移动到独立回收站目录，并保存原路径、标题、大小和归档状态。恢复时会还原到原位置；如果原位置已经存在同名记录，插件会拒绝覆盖。

### 4. 无数量上限的回收站

插件不会因为回收站达到固定条数而自动删除旧会话。回收站容量只受磁盘空间限制，用户可以自行选择何时清理。

### 5. 永久清除有明确确认和故障恢复

永久清除只能针对回收站中的会话，界面会要求二次确认。Host 端采用“隔离 → 提交元数据 → 物理清理”的两阶段流程：如果进程在中途退出，下一次 DSH 启动时会自动尝试恢复或完成未结束的清理，避免只删文件或只删索引造成不一致。

### 6. 不触碰工作区文件

永久清除只删除 DSH 的会话持久化记录和相关投影缓存，不删除工作区中的源代码、下载文件、构建产物或用户手动创建的其它文件。

### 7. 最小化集成面

- 不注册模型工具；
- 不向模型提示词添加内容；
- 不做 DOM 注入；
- 不修改 Router Standard/Spec、模型端点、搜索插件、视觉插件或技能；
- Host API 只接受本机 loopback、同源请求。

### 8. 启动时自动对账孤儿状态

归档标记和会话标题缓存都以会话 ID 为键长期保存。如果会话不是通过本插件删除的（例如手动删除记录目录），这些键会残留下来，并且在界面上完全不可见。插件每次启动会用一次成功的会话列举结果做对账，清理掉指向已不存在会话的残留键。

列举失败时对账会整体跳过并留到下次启动，绝不会退化成「读不到就删」——否则一次存储故障就会被放大成归档状态被清空。

## 兼容性

| 项目 | 要求 |
| --- | --- |
| DSH | `0.1.0-rc.7` 及以上（已在 `0.1.1-rc.2` 上验证） |
| Node.js | `22.19+` 或 `24+` |
| Profile | `web` |
| 存储后端 | DSH Web 默认的 JSON storage/domain 组合 |
| 持久化后端 | 需要提供独立会话记录路径的 `sessionPersistence` |

插件使用了自 rc.7 引入的 `workspaceRegistry.requireState()` / `setState()` 状态原语来实现取消归档，因此不保证兼容更早版本。使用非标准会话持久化后端时，如果后端无法定位独立会话目录，插件会拒绝移动操作，而不是猜测或删除未知文件。

## 安装

### 从 GitHub 安装（推荐）

在 WSL 或 DSH 所在环境中执行：

```bash
dsh plugin --profile web add github:fujunchao/dsh-session-vault
```

然后重启 Web 服务：

```bash
sudo systemctl restart dsh-web.service
```

如果你的环境不是 systemd 服务，则停止当前 `dsh web` 进程后重新执行 `dsh web` 即可。

### 本地开发链接安装

```bash
dsh plugin --profile web add 'link:/absolute/path/to/dsh-session-vault'
sudo systemctl restart dsh-web.service
```

### 验证安装

```bash
dsh plugin --profile web list
```

列表中应出现：

```text
dsh-session-vault
```

随后打开 **设置 → 会话保险库**。注意：本插件是标准 DSH Host/Client 插件，**不通过 `dsh-super-injector` 管理**；因此 Super Injector 页面显示“注入器已加载 0 个插件”是正常的，不代表本插件没有加载。

## 使用方法

### 归档会话

1. 打开 **设置 → 会话保险库 → 活动**；
2. 勾选一个或多个会话；
3. 点击 **归档**。

归档只改变 DSH 的显示/工作区状态，不删除会话记录。要恢复显示，进入 **归档** 标签页并点击 **移出归档**。

### 移入回收站

1. 在 **活动** 或 **归档** 标签页选择会话；
2. 点击 **移入回收站**；
3. 等待操作完成后，会话会出现在 **回收站**。

正在运行的会话，以及无法定位独立持久化目录的会话不会被强制删除，请先结束会话再重试。仅仅在 Web UI 中打开、当前处于空闲的会话可以直接删除：DSH 没有提供单独关闭某个会话实例的接口，若仅因实例存在就拒绝，会话在正常使用下将几乎无法清理。

### 恢复会话

1. 打开 **回收站** 标签页；
2. 选择需要恢复的会话；
3. 点击 **恢复**。

插件会恢复原始目录和原始归档状态。如果原位置已有同名目录，恢复会失败并保留回收站内容，避免覆盖现有数据。

### 永久清除

1. 在 **回收站** 中选择会话；
2. 点击 **永久清除**；
3. 阅读提示并勾选确认项；
4. 再次点击确认按钮。

该操作不可逆，只处理已进入回收站的 DSH 会话记录。建议在清理前确认会话中没有需要保留的对话内容。

### 搜索和批量操作

搜索框支持以下内容：

- 会话标题；
- `session-...` 会话 ID；
- 工作目录路径。

“全选当前结果”只选择当前标签页和搜索结果中的可操作条目，不会跨标签页误选。

## 数据与安全

### 文件位置

| 路径 | 用途 |
| --- | --- |
| `~/.dsh/storages/dsh_session_vault.json` | 回收站元数据（首次产生记录后生成） |
| `~/.dsh/session-vault/trash/<session-id>/` | 可恢复的会话记录目录 |
| `~/.dsh/session-vault/purging/<session-id>/` | 永久清除期间的事务隔离目录 |
| `~/.dsh/sessions/` | DSH 原始会话记录目录（由 DSH 自己维护） |

插件不会把 API key、模型端点或凭据写入仓库，也不会读取或上传搜索插件的凭据。仓库中的示例和测试均不包含用户的会话数据。

### Host API 边界

内部 API 前缀为 `/dsh-session-vault/api`：

- `GET /snapshot`：读取会话和回收站快照；
- `POST /batch`：执行批量操作，body 为 `{ "action": "...", "sessionIds": [...] }`。

这些接口不是对外开放的公共 API。插件会校验远端地址、`Host`、`Origin` 和 Fetch Metadata，只允许本机同源请求。不要把 DSH Web 端口直接暴露到公网或不可信局域网；该接口本身不提供账号认证。

## 故障排查

### 设置里没有“会话保险库”

1. 确认 `dsh plugin --profile web list` 中有 `dsh-session-vault`；
2. 重启 DSH Web 服务；
3. 浏览器硬刷新设置页；
4. 查看 `journalctl -u dsh-web.service -n 100` 中的插件加载错误。

### Super Injector 显示 0 个插件

这是预期行为。本插件通过 profile 的标准 bundle 挂载，不属于 Super Injector 的目录注入清单。请以 **设置 → 插件 → 插件列表** 中的 `session-vault` 和 **设置 → 会话保险库** 页面为准。

### 会话无法移入回收站

常见原因是会话仍在运行，或所用持久化后端没有独立目录。结束会话后再试；插件不会因为删除按钮被点击就猜测路径。注意：会话只是在 Web UI 中打开并不会阻止删除，无需为此重启 DSH。

### 看到 `cannot get property "storageDomain" without inject`

这是旧构建产物或入口元数据未更新造成的加载错误。请重新安装 GitHub 版本并重启 DSH：

```bash
dsh plugin --profile web remove dsh-session-vault
dsh plugin --profile web add github:fujunchao/dsh-session-vault
sudo systemctl restart dsh-web.service
```

### 永久清除后仍看到隔离目录

不要手动删除 `purging/<session-id>`。重启 DSH 后插件会扫描隔离目录并自动完成或回滚未完成的事务；如仍失败，请保留日志并提交 Issue。

## 开发与测试

```bash
git clone https://github.com/fujunchao/dsh-session-vault.git
cd dsh-session-vault
pnpm install --frozen-lockfile
pnpm check
```

`pnpm check` 会依次执行：

1. TypeScript 类型检查；
2. Vitest 单元测试；
3. Host/Client 构建；
4. Host/Client bundle 入口冒烟测试。

源码目录：

```text
src/index.ts       Host 插件、API、文件事务
src/client.tsx     设置页 UI
src/core.ts        路径、会话 ID、请求边界校验
src/contract.ts    Host/Client 共享类型
tests/             单元测试和 bundle 冒烟测试
lib/               发布和 DSH 运行时加载的构建产物
```

开发完成后需要重新构建 `lib/`，因为 DSH 安装和运行时加载的是构建产物，而不是直接执行 TypeScript 源码。

## 项目结构

本插件由两个标准入口组成：

- **Host**：依赖 `webServer`、`sessionPersistence`、`workspaceRegistry`、`agents` 和 `storageDomain`，负责安全 API 与会话目录操作；
- **Client**：依赖 DSH 的 slots、locale、sessions、workspaces 服务，只注册一个 `settings.section` 设置区。

它没有模型工具入口，也没有 Super Injector 专用注入入口。

## 许可证

[MIT License](LICENSE)

欢迎提交 Issue 和 Pull Request。提交问题时请删除会话内容、API key、凭据和私人路径等敏感信息。

