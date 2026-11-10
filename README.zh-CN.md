# Passeur

[English](README.md) · **简体中文**

跑在 Cloudflare Workers + D1 上的 Telegram 双向私聊机器人：每个访客一个论坛话题，多个管理员账号共同回复。

<!-- TODO: 换成管理群截图 (docs/assets/topic.png) -->
```text
Guest (DM with @your_bot)              Admin group · topic "Alice · 123456789"
──────────────────────────             ─────────────────────────────────────────
Alice: hi, is the camera still   ──▶   🤖 Alice: hi, is the camera still for sale?
       for sale?
                                 ◀──   Account 1: yes — photos below  [album]
🤖 yes — photos below  [album]
                                 ◀──   Account 2: (forwards a channel post here)
🤖 (the post, copied)
```
*访客只看得到 bot；你的两个号在同一个话题里回复。*

## 目录

- [为什么是 Passeur？](#-为什么是-passeur)
- [亮点](#-亮点)
- [快速开始](#-快速开始)
- [部署](#-部署)
- [使用](#-使用)
- [配置](#-配置)
- [更新与维护](#-更新与维护)
- [工作原理](#-工作原理)
- [项目结构](#-项目结构)
- [开发](#-开发)
- [常见问题与排错](#-常见问题与排错)
- [安全](#-安全)
- [局限与路线](#-局限与路线)
- [文档地图](#-文档地图)
- [许可](#-许可)

## 💡 为什么是 Passeur？

你想让陌生人能在 Telegram 上联系你，又不想暴露自己的账号，还想用不止一个号来回复。Passeur 在一个私有论坛群里给每位访客开一个话题；管理员在话题里发的任何东西（手打的、转发来的、相册）都会以 bot 的身份送达访客。

- ✅ 适用：个人或少数几个可信账号，处理来自公开渠道的私聊，零托管成本。
- ❌ 不适用：需要分工、指派的客服团队，或每天上千访客——请用专门的客服系统，或部署在付费服务器上的 bot。

## ✨ 亮点

- **一个访客一个话题**：聊天记录互不混杂；话题以访客名字命名，对方改名时自动同步。
- **多个管理员账号**：`ADMIN_IDS` 里的每个号都能回复；在任何地方看到的内容可以直接转发进访客的话题。
- **相册保持为相册**：媒体组会先缓冲再整组发送，双向都是。
- **回复与编辑同步**：回复某条具体消息，对面看到的也是回复；文字和图片说明的修改会同步过去。
- **防骚扰**：新访客点一下完成算术验证，每人限速，另有 `/block`。
- **名单话题**：一个话题可以代表一组访客，在里面发或转发的内容会发给名单上的每个人。
- **广播**：一条消息发给所有已验证的访客，分批发送以免超出免费额度。
- **零成本运行**：每条消息约 2 次 Worker 请求、读约 25 行、写约 2 行 D1；个人用量不到免费额度的 1%。

## 🚀 快速开始

需要 Node.js 22.13+、一个 Cloudflare 账号，以及 [@BotFather](https://t.me/BotFather) 给的 bot token。

1. 建一个**超级群**，打开**话题（Topics）**，把 bot 设为管理员并勾选**管理话题**。
2. 克隆并运行安装脚本，它会询问缺少的配置并完成部署：

   ```bash
   git clone https://github.com/10ta/Passeur.git
   cd Passeur
   ./update.sh
   ```

   最后会输出 `==> 完成：webhook 待处理 0 条`，并提示下一步。
3. 用每个管理员号私聊 bot 发 `/id`，把数字填进 `.env` 的 `ADMIN_IDS`。把这些号拉进群，在群里发 `/id`，结果填进 `GROUP_ID`，再运行一次 `./update.sh`。
4. 在群的 **General** 话题里发 `/check`，每一行都应以 ✅ 开头。
5. 用任意其他账号私聊 bot：群里会出现一个以该账号命名的话题。

## 🚢 部署

> [!IMPORTANT]
> Cloudflare 的免费额度是**按账号**计算的，与你的其他 Worker 共用：每天 100,000 次请求、5 个 Cron Trigger（Passeur 占 1 个）、D1 共 5 GB。如果使用 Cloudflare API Token，它能操作整个账号。

### 前置要求

| 组件 | 版本 | 说明 |
|---|---|---|
| Node.js | ≥ 22.13 | 运行 `update.sh` 的辅助脚本和测试 |
| bash、curl | 任意 | `update.sh` 是 bash 脚本；在任何 shell（包括 fish）里用 `./update.sh` 运行 |
| Cloudflare | Workers 免费版或付费版 | `npx wrangler login`，或带 Workers Scripts:Edit + D1:Edit 权限的 API Token |

| 运行 `update.sh` 的平台 | 支持 |
|---|---|
| Linux（Debian/Ubuntu） | ✅ |
| macOS | ✅ |
| Windows（WSL 之外） | ❌ |

### `update.sh` 做了什么

每一步都是幂等的，所以安装和更新是同一条命令：

1. 从 `.env.example` 创建 `.env`（权限 600），询问为空的配置项，并检查 `GROUP_ID` 是 bot 能访问到的群。
2. D1 数据库 `passeur` 不存在时，在西欧创建（靠近 Telegram 的 API 服务器），并由 `wrangler.example.toml` 生成 `wrangler.toml`。
3. 应用 `migrations/`，部署 Worker，把配置作为 Worker secrets 推上去。
4. 把 Telegram webhook 指向 `https://<worker>/webhook` 并带上密钥头，同时设置命令菜单。

没有终端时（cron、CI）它不会提问：缺少必填项就直接失败。

### 自定义域名

在 Cloudflare 后台给 Worker 加路由或自定义域名，把 `.env` 里的 `WORKER_URL` 改成它，然后运行 `./update.sh` 迁移 webhook。

## 🧭 使用

### 回复访客

打开该访客的话题直接写。只要不是 `/命令`，都会发给访客：文字、媒体、贴纸、语音、相册。两个管理员号都能在同一个话题里回复。

你在话题里的最近一条消息上会带一个标记：👌 表示已送达，👀 表示对方之后又发过消息。Telegram 不告诉 bot 对方是否已读，所以 👀 只是推断；标记只保留在最近一条上，你再发新消息时它会移过去。

### 用号1 把内容转给访客

在任意聊天里点**转发** → 选管理群 → 选该访客的话题。访客收到的效果和普通转发一样，显示“转发自”原始来源。你自己的号不会露出来：来源是任一管理员账号或管理群本身的消息，会改用复制；开了转发隐私、只显示名字的管理员号也一样（按名字识别）。想隐藏来源，就在 `/settings` 里改**转发来源**（全局或单个会话）。

### 回复某条具体消息

在话题里用 Telegram 的**回复**；访客看到的是对他那条消息的回复。反方向同理。

### 一条消息发给多个访客

话题就是收件人名单：访客自己的话题只发给他一个人，**名单话题**发给名单上勾选的每个人。

1. `/newlist 客户` 会新建话题 `📤 客户`，并在里面贴出面板。勾选访客（☐/☑），每点一下立即保存，最多 45 人。在该话题里发 `/list` 可以重新调出面板。
2. 往 `📤 客户` 里发或转发任何内容（文字、媒体、相册），都会复制给名单上没被拉黑的每个人。
3. 全部送达时，你的消息上会出现 👌；否则 bot 会回复一条，列出谁没收到以及原因。

访客话题始终是一对一的，因为访客的回复总是回到他自己的话题。两个管理员号之间的商量不要放在名单话题里：那里的每条消息都会发出去。

名单话题可以在 Telegram 里随意改名，Passeur 会跟着更新名字；功能按话题而不是按名字识别。Telegram 删除话题时不会通知 bot，所以不用的名单要在 `/settings` → 💬 会话设置 → 该名单 → 🗑 移除名单（成员和它的单独设置会被清除，话题本身保持原样）。

### 修改设置

在 **General** 里发 `/settings`。面板显示全局设置；点 **💬 会话设置** 会列出所有会话（名单话题在前，访客按最近联系排序，每页 20 个，⚙️ 表示已有单独设置），选一个就进入该会话的设置。全部操作都在 General 里的这一条消息上完成，不需要在访客话题里打字。每个按钮点一下切到下一个选项并立即保存；面板会注明每个值来自哪里（本会话、全局、`.env` 或默认）。选到**默认 / 跟随全局**即取消覆盖。

| 设置 | 全局 | 单个话题 | 选项 |
|---|---|---|---|
| 转发来源 | ✅ | ✅ | 保留（默认）· 仅频道 · 隐藏 |
| 新访客验证 | ✅ | ❌ | 开（默认）· 关 |
| 访客限速 | ✅ | ❌ | 每分钟 10 · 20（默认）· 60 · 不限 |
| 送达标记（👌/👀） | ✅ | ✅ | 开（默认）· 关 |
| 消息对应保留 | ✅ | ❌ | 30 · 90（默认）· 365 天 |

### 命令

| 命令 | 位置 | 作用 |
|---|---|---|
| `/info` | 访客话题 | 访客的名字、用户名、ID 和状态 |
| `/block` / `/unblock` | 访客话题 | 静默丢弃 / 恢复接收该访客的消息 |
| `/settings` | General | 设置面板：全局设置，以及「💬 会话设置」里的单个会话 |
| `/newlist <名字>` | 群内任意位置 | 新建名单话题 `📤 <名字>`，附成员面板 |
| `/list` | 名单话题 | 重新调出成员面板 |
| `/broadcast` | General，回复某条消息 | 把被回复的那条消息发给所有已验证、未拉黑的访客 |
| `/cancel` | General | 停止进行中的广播 |
| `/blocked`、`/stats` | 群内任意位置 | 拉黑列表；用户统计 |
| `/check` | 群内任意位置 | 检查话题开关、bot 权限和管理员账号；在不是 `GROUP_ID` 的群里会提示不一致 |
| `/id` | 群或私聊 | 显示聊天 ID（`GROUP_ID` 未设置时也可用） |
| `/help` | 群内任意位置 | 显示这张表 |

只有 `ADMIN_IDS` 里的账号能用；其他群成员的消息一律忽略。例外：在不是 `GROUP_ID` 的群里，`/id` 和 `/check` 对任何人都会回应，方便排查配置错误。

## 🔧 配置

连接类配置写在 `.env` 里（模板：[`.env.example`](.env.example)）；`update.sh` 每次运行都会把它们作为 secrets 推到 Worker，所以请改 `.env` 后重新运行，不要在后台直接改。表中最后五行只是初始值：`/settings` 面板会覆盖它们（见[修改设置](#修改设置)），优先级为 话题 → 面板 → `.env` → 默认。

| 名称 | 必填 | 默认值 | 说明 |
|---|---|---|---|
| `BOT_TOKEN` | ✅ | — | @BotFather 给的 token |
| `ADMIN_IDS` | ✅ | — | 管理员账号 ID，逗号分隔 |
| `GROUP_ID` | ✅ | — | 论坛超级群 ID（`-100…`）；为空时进入设置模式，只响应 `/id` |
| `WEBHOOK_SECRET` | ✅ | 自动生成 | Telegram 每次调用 webhook 时回传的密钥 |
| `WORKER_URL` | ✅ | 取自部署输出 | Worker 的根地址 |
| `CLOUDFLARE_API_TOKEN` | ❌ | — | 不用 `npx wrangler login` 时才需要 |
| `CLOUDFLARE_ACCOUNT_ID` | ❌ | — | token 能看到多个账号时才需要 |
| `WELCOME_TEXT` | ❌ | 内置 | 回复 `/start` 的内容；用 `\n` 换行 |
| `VERIFY` | ❌ | `1` | 新访客需通过算术验证 |
| `RATE_LIMIT_PER_MIN` | ❌ | `20` | 每位访客每分钟消息数上限；`0` 为关闭 |
| `FORWARD_SOURCE` | ❌ | `all` | `all` / `channel` / `none`：转发来的消息是否保留“转发自”（旧的 `FORWARD_CHANNEL_POSTS=1` 等同 `channel`） |
| `RETENTION_DAYS` | ❌ | `90` | 消息之间的回复 / 编辑对应关系保留天数 |
| `RECEIPTS` | ❌ | `1` | 访客话题里最近一条消息上的 👌/👀 标记 |

## 🔄 更新与维护

### 更新

```bash
git pull
./update.sh
```

### 数据与备份

所有数据都在 D1 数据库 `passeur` 里：访客、拉黑列表、话题 ID，以及消息对应关系（保留 `RETENTION_DAYS` 天）。消息内容本身留在 Telegram 里。

```bash
npx wrangler d1 export passeur --remote --output backup.sql
```

恢复到新数据库：`npx wrangler d1 execute passeur --remote --file backup.sql`。

### 日志

```bash
npx wrangler tail passeur
```

错误也会发到群的 General 话题，并记录在后台的 Workers Logs 里（免费版保留 3 天）。

### 卸载

```bash
./uninstall.sh
```

每一步都会先确认：解除 webhook、删除 Worker（连同 secrets 和定时任务）、删除 D1 数据库。Telegram 群不会被动。

## 🧠 工作原理

```mermaid
flowchart LR
  G[Guest DM] -- webhook --> W[Worker /webhook]
  A1[Account 1] -- post / forward into topic --> T[Admin group topic]
  A2[Account 2] -- post into topic --> T
  T -- webhook --> W
  W -- copyMessage --> T
  W -- copyMessage --> G
  W <--> D[(D1: users, msg_map, albums, broadcasts)]
  C[Cron */5] --> W
```

- **话题就是收件人名单** → 访客话题对应它的访客（`users.topic_id`），名单话题对应它的成员（`list_members`）；同一条发送路径，同一条规则。
- **话题与访客的对应是 D1 里的一行** → 任何管理员号都能回复，bot 内存里不保存访客的任何状态。
- **手打的消息复制，转发来的消息保留来源** → 访客看到的是 bot，看不到是哪个管理员号回的；来源是管理员账号或管理群本身时一律复制。
- **设置按 话题 → 面板 → `.env` → 默认 解析** → 全部登记在 `src/settings.js` 一张表里；单个话题的设置用同一张表，作用域为 `t:<话题>`。
- **webhook 始终返回 200** → Telegram 不会重试，消息不会重复发送；失败会在话题或 General 里报告。
- **相册在 `waitUntil` 里缓冲 2.5 秒** → 等待消耗的是墙钟时间而不是 CPU，符合 10 毫秒 CPU 限制；每个相册项只会被认领一次。
- **广播每批 40 人** → 免费版每次调用最多 50 个外部请求；剩下的由每 5 分钟一次的定时任务接着发。
- **每条消息涉及的查询都走主键或索引** → 读取行数与返回行数基本一致。

### 每条消息的开销（在测试替身上实测）

| 路径 | Worker 请求 | D1 查询 | D1 写入行 | CPU |
|---|---|---|---|---|
| 访客 → 话题 | 1 | 3 | ~2 | < 1 ms |
| 话题 → 访客 | 1 | 2 | ~2 | < 1 ms |
| 新访客（建话题 + 信息卡） | 1 | 8 | ~5 | < 1 ms |

定时任务每天另加 288 次请求。免费版最先触到的上限是整个账号每天 100,000 次请求。

## 📁 项目结构

```text
.
├── src/
│   ├── index.js       # Worker entry: webhook auth, routing, cron
│   ├── guest.js       # Guest DMs: captcha, rate limit, relay to topic, edits
│   ├── admin.js       # Admin group: relay to guest, commands, /check
│   ├── relay.js       # copy/forward, albums, topic creation and recovery
│   ├── broadcast.js   # Batched broadcast
│   ├── lists.js       # List topics: member panel, fan-out
│   ├── settings.js    # Settings registry, resolution, /settings panel
│   ├── receipts.js    # 👌/👀 marks on the latest admin message
│   ├── db.js          # All D1 queries
│   └── telegram.js    # Bot API client
├── migrations/        # D1 schema
├── scripts/env.mjs    # .env and JSON helpers for update.sh
├── test/              # node:test suite with fake D1 and Telegram
├── update.sh          # Install / update (idempotent)
└── uninstall.sh       # Remove Worker, D1, webhook
```

## 🔨 开发

```bash
npm install
npm test
npm run build
```

`npm test` 用一份真实 SQLite 建的表结构和一个假的 Bot API 跑测试，不需要联网。`npm run build` 只打包不部署（输出 `Total Upload: … KiB`）。Telegram 访问不到本机的 `wrangler dev`，所以端到端验证要在部署后的 Worker 上做。面向编码代理的约定见 [AGENTS.md](AGENTS.md)。

## ❓ 常见问题与排错

**访客收到“发送失败”或没有任何回应，群里 `/check` 没反应，`update.sh` 提示 `chat not found`**
→ `GROUP_ID` 不是管理群的 ID。最常见的是填了 Telegram Web 地址栏里的 `-123…`，Bot API 里同一个群写作 `-100123…`。
→ 在管理群里发 `/id`（任何人都能用，配置错误时也能用），把结果填进 `.env`，运行 `./update.sh`。`update.sh` 也会发现缺了 `-100` 并提示正确的值。

**用某个管理员号转发的内容，访客那边仍能看到这个号的名字**
→ 这个号开了转发隐私，Telegram 只给 bot 一个名字。Passeur 会从这些地方记下管理员的名字：他们在群里的发言、私聊 bot、`/check`，最后还会主动向 Telegram 查询。如果仍然漏过，就用那个号私聊 bot 一次（或运行 `/check`），并确认 `/check` 的结果里列出了它的名字。

**在 Telegram 里删掉的名单话题，仍出现在「💬 会话设置」里**
→ Telegram 删除话题时不会通知 bot。在会话设置里打开它，点 🗑 移除名单。

## 🔒 安全

- webhook 只接受在 `X-Telegram-Bot-Api-Secret-Token` 里带有 `WEBHOOK_SECRET` 的请求。
- 只有 `ADMIN_IDS` 能转达消息或使用命令。开着**“保持匿名”**的管理员发的消息会被拒绝，因为看不到真实发送者。
- `.env` 存有 bot token，权限保持 600；`update.sh` 通过标准输入把 token 交给 curl，从不出现在命令行参数里。
- token 泄露时：在 @BotFather 里重置，把新 token 填进 `.env`，运行 `./update.sh`。

## 🚧 局限与路线

- 编辑同步只覆盖文字和图片说明；替换图片不会同步。
- 访客在通过验证前发的消息只保留第一条（相册最多保留其中一项）。
- 广播只发一条消息；回复的是相册时只广播第一项。
- 送达标记：👀 表示对方在你之后发过消息，不等于已读；只保留在最近一条消息上。
- 名单话题：每个名单最多 45 人（每人占 1 次 Bot API 调用，免费版每次调用上限 50）；不做编辑同步；访客回复名单消息时，回复会进他的话题，但不显示“回复了哪条”。
- 管理员以 `/` 开头的文字会被当作命令，不会发出。
- 单个访客刷屏时，即使消息被丢弃，每条仍会消耗一次 Worker 请求。

### 环境事实与待确认事项

| 事项 | 状态 | 确认方法 |
|---|---|---|
| bot 转发一条本身就是转发来的消息时，访客看到的是原始来源，而不是管理群 | 已确认（2026-11-10） | — |
| bot 往已关闭的话题发消息时，Telegram 返回 `TOPIC_CLOSED` | 推断；Passeur 会重新打开话题 | 关闭一个话题，再用该访客给 bot 发消息 |
| D1 对每个被改动的索引额外计一行写入 | 据文档推断 | 在 Workers Logs 里看一次消息写入的 `meta.rows_written` |

## 📚 文档地图

- [AGENTS.md](AGENTS.md)：面向 AI 编码代理的命令、不变量和坑。
- [.env.example](.env.example)：每个配置项及其注释。
- [migrations/0001_init.sql](migrations/0001_init.sql)：数据库结构及字段说明。

## 📄 许可

MIT © 2026 10ta，见 [LICENSE](LICENSE)。
