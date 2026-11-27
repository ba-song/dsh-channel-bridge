# dsh-channel-bridge

> QQ / OneBot 通道插件（桥）。把「家里」和 QQ 连起来：收 QQ 消息投进会话、把她说的话发回 QQ，
> 并把图片/语音落盘、群聊规则、轮换、补收对账、假在线检测这些传输层的事都收在桥里。
>
> 版本：0.18.0（2026-11-10）。默认 `enabled:false`、`mode:'observe'`，由统筹者在 profile 里启用。

## 1. 功能一览

- **收**：OneBot v11 WS 事件（私聊/群聊）→ 去重 →（unified 时转 home）→ 富化附件 → 投进会话；
- **发**：`dy_say`（QQ 文本 / email）、图片、语音、QQ 原生表情、改资料/状态/头像；
- **附件**：图片/文件/语音落盘 `/sdcard/DSHA/渠道/qq/附件/<day>/`，正文给绝对路径；
  2026-11-16 起：图片 url 失效用 SL `get_image` 换新地址兜底、同 md5 图去重、多图并发（3）、群聊第一张图直投成 image 附件；
  发送一律 **base64**（SnowLuma 在另一个容器，`file://` 看不到我们的 `/tmp`、`/sdcard`）；
- **引用（2026-11-16）**：入站 `reply` 段只带 `message_id`，桥用 `get_msg` 反查被引用原文，
  正文前拼 `[引用 某某：原文…]`；`dy_say` 新增可选 `replyTo`，发消息时带 `reply` 段（只第一段带）；
- **QQ 常用能力（2026-11-16）**：拍一拍、表情回应、发文件、发视频、合并转发（收+发）、
  群成员/群资料/群公告、好友列表/备注/加删好友、收藏表情、卡片(txt)解析；
- **notice 事件（2026-11-16）**：撤回/拍一拍/进群退群/禁言/管理员/群文件/好友添加 全部落库，
  按 `notices.deliver` 白名单投进会话（默认只投撤回/拍一拍/好友添加，避免噪音）；
- **群规则**：默认只有 @ 她才回；@ 后开「跟话窗口」，窗口内不 @ 也投；被 @ 时带近况+群上下文；
- **房间规矩**（`【这个房间的规矩】`）只在**新会话/轮换后的第一条**带一次，后续消息与补收/重放都不重复注入（与 home 一致）；
- **会话**：**每个群 / 每个陌生私聊一个会话**（key=`group:<群号>` / `private:<QQ号>`），
  cwd 分别 `qq-群/<群号>`、`qq-私聊/<QQ号>`（自动 `mkdir -p`）；主人私聊走 unified 进 home；500k/70% 自动轮换；
- **可靠性**：启动补收（只补未回复的尾巴）、60s 周期对账、假在线（SILENT）检测、断线退避重连；
- **统一模式**：`unified:true` 时 QQ 私聊不再自建会话，转 `dyHome.deliver`（home 是唯一私聊会话）；
- **公开层**：群 @ 时读 `dyMemory.publicBrief` 拼 `[汐的近况]`；群窗口关闭时把**摘要**交 `dyMemory.saveGroupDigest`，
  并把**全文**交 `dyMemory.saveGroupTranscript`（只写记忆库、按需查，不进 home 上下文）。

## 2. 工具清单

所有工具都是 owner 面向；**发送类都受 mode 闸门**（observe 不发；deliver 只投递不发送；send 全开），
私聊目标需在 owner 白名单或最近 7 天联系人窗口内，群聊目标需在联系人目录里；表情/语音同一目标 5 秒限流（图片 2026-11-14 起不限流）。

### 2.1 `dy_say` — 发文本（QQ / email）

| 参数 | 说明 |
|---|---|
| `channel` | `'qq'`（默认）或 `'email'`（抖音未开放） |
| `contactId` | QQ 号/群号，或邮箱地址（email） |
| `kind` | qq 必填：`private` / `group` |
| `subject` | 仅 email：主题，默认「汐的邮件」 |
| `replyTo` | 可选：要引用的 QQ `message_id`（可负）；只给第一段消息带 `reply` 段 |
| `text` | 正文；QQ ≤2000 字（`say.maxTextChars`），email ≤5000；`[SILENT]` = 不发 |

- QQ：按 60 字/4 段自动拆条，逐条 `send_private_msg`/`send_group_msg`（`auto_escape:true`）；
  返回 `{ok, mode, delivered, parts, mirrored, via, message_ids}`；失败进 outbox 留底，返回 `E_OFFLINE`。
- email：`ctx.get('dyMail')` 缺失 → `E_CHANNEL_UNAVAILABLE`；`contactId` 必须在
  `dyMail.ownerAddresses()`（大小写不敏感）否则 `E_NOT_OWNER`；调 `dyMail.send({to,subject,body})`，
  **失败不重试**；返回 `{ok, channel:'email', delivered, to, subject}`。

```json
{"channel":"qq","contactId":"<OWNER_QQ_ID>","kind":"private","text":"在呢"}
{"channel":"email","contactId":"owner@example.com","subject":"晚安","text":"早点睡"}
```

### 2.2 `dy_send_image` — 发图片

`{path, kind='private', contactId, caption?}`

- 绝对路径，白名单 `/sdcard/DSHA`、`/tmp`；`png/jpg/jpeg/gif/webp`；原图 **≤10MB**；
- 读文件 → `[{type:'image',data:{file:'base64://…'}}]`（有 `caption` 先发文字段）；
- 错误码：`E_PATH / E_FORMAT / E_TOO_LARGE / E_NO_CONTACT / E_MODE_OBSERVE / E_SEND_FAILED`（不再返回 `E_RATE_LIMIT`：原 5 秒/张已解除）；
- 审计只记 basename + 字节数，不记内容。

### 2.3 `dy_send_voice` — 发语音

`{path, kind='private', contactId, caption?}`

- 白名单同上；`wav/mp3/silk`；原文件 **≤5MB**；
- `[{type:'record',data:{file:'base64://…'}}]`；错误码同图片；审计 `qq_ops(action='send_voice')`。

### 2.4 `dy_send_face` — 发 QQ 原生表情

`{id, kind='private', contactId}`；`id` 1–300（整数）；段 `{type:'face',data:{id}}`；限流 5 秒。

### 2.5 `dy_qq_profile` — 改昵称/签名/性别（写操作）

`{nickname?, signature?, sex?, confirm}`

- 不传 `confirm:true` → `E_CONFIRM_REQUIRED` 并列出会改哪些字段，**一次都不调**；
- `nickname`/`sex`（0/1/2）→ `set_qq_profile`；`signature` → `set_self_longnick({long_nick})`；
- 写后 `get_login_info` + `get_stranger_info` 回读 `before/after`；**写失败不重试**；
- 审计 `qq_ops(action='profile', fields, ok)`。

### 2.6 `dy_qq_status` — 改在线状态（写操作）

`{status, confirm}`；状态 10 在线 / 30 离开 / 40 隐身 / 50 忙碌 / 60 勿扰 / 70 学习；
缺 confirm → `E_CONFIRM_REQUIRED`；调 `set_online_status`，不重试。

### 2.7 `dy_qq_avatar` — 改头像（写操作）

`{path, confirm}`；白名单同上；`png/jpg/jpeg`；原图 **≤2MB**；缺 confirm → `E_CONFIRM_REQUIRED`；
`set_qq_avatar({file:'base64://…'})`，不重试；返回 `{ok, bytes, result:<脱敏>}`。

### 2.8 `dy_bridge_rotate` — 手动换会话（owner）

`{channel='qq', kind='private'}`；立刻按 B 方案换新会话（`agentPreset:'standard'`、`isSeeded:true`、
seed = handoff-note 提示 + 旧会话最近 50 条原话）；记 `prev_session_id`、旧会话留档；
回合处理中 `E_BUSY`；返回 `{ok, oldSessionId, newSessionId, seeded, count}`。

### 2.9 `dy_qq_recall` — 撤回消息（owner 写操作）

`{messageId}`；调用 `delete_msg({message_id})`（负值合法）；失败不重试；审计 `qq_ops(action='recall')` 只记 id。

### 2.10 `dy_qq_forward` — 转发单条消息（owner 写操作）

`{messageId, toKind:'private'|'group', toId}`；对应 `forward_friend_single_msg({message_id,user_id})`
/ `forward_group_single_msg({message_id,group_id})`；失败不重试；审计 `action='forward'`。

### 2.11 `dy_qq_friend_request` — 可疑好友申请（owner）

`{action:'list'|'approve'|'reject', flag?, confirm?}`：`list` → `get_doubt_friends_add_request({count:20})`（只读）；
`approve`/`reject` → `set_doubt_friends_add_request({flag,approve})`（flag 用列表项 `uid`，不能按 QQ 号构造）；
`approve` 必须 `confirm:true`；失败不重试；审计 `action='friend_request:<action>'`（不记 flag）。

### 2.12 `dy_qq_poke` — 拍一拍（写）

`{kind:'private'|'group', contactId, userId?}`。私聊 → `friend_poke({user_id})`；群 → `group_poke({group_id,user_id})`（群拍必须给 `userId`）；
失败不重试；审计 `qq_ops(action='poke')`。

### 2.13 `dy_qq_reaction` — 消息表情回应（写）

`{messageId, emojiId, set?}` → `set_msg_emoji_like({message_id, emoji_id, set})`；`set:false` 取消；
`emojiId` 规则（SL 实测）：长度 ≤3 → QQ 小表情 id（`76`=赞、`4`=得意）；长度 >3 → Unicode 码点（`128077`=👍）；
**私聊不支持**（SL 报 `emoji reactions are not supported on private messages`），群聊可用；审计 `action='reaction'`。

### 2.14 `dy_qq_forward_msg` — 合并转发（写）

`{kind, contactId, items:[{senderName?,text}]}`（最多 20 条）→ `send_private_forward_msg` / `send_group_forward_msg`；
节点用 `buildForwardNodes` 拼 `{type:'node'}`；失败不重试。

### 2.15 `dy_qq_get_forward` — 读合并转发（只读）

`{id?, messageId?}` 二选一 → `get_forward_msg`；返回节点数与渲染文本（`formatForward`，最多 8 条/600 字）。

### 2.16 `dy_qq_members` — 群成员列表（只读）

`{groupId, limit?}` → `get_group_member_list`；返回 `userId/nickname/card/role/lastSentTime`。

### 2.17 `dy_qq_group_info` — 群资料 + 公告（只读）

`{groupId}` → `get_group_info` + `_get_group_notice`；返回群名/人数/最近 3 条公告。

### 2.18 `dy_qq_friends` — 好友列表（只读）

`{limit?}` → `get_friend_list`；返回 `userId/nickname/remark`。

### 2.19 `dy_qq_custom_face` — 收藏表情

`{action:'list'|'send', emojiId?, kind?, contactId?}`：`list` → `fetch_custom_face`（实测返回 URL 字符串数组，
`emojiId` 取 URL 里的 32 位 MD5）；`send` → `send_custom_face({emoji_id, user_id|group_id})`；发送失败不重试。

### 2.20 `dy_qq_friend` — 好友关系（写，必须 confirm）

`{action:'add'|'delete'|'remark'|'approve'|'blacklist'|'report', userId?, flag?, message?, remark?, confirm}`：
- `delete` → `delete_friend`；`remark` → `set_friend_remark`；`add`/`approve` → `set_friend_add_request({flag,approve:true})`；
- `blacklist` → `delete_friend({user_id, block:true})`（SL 没有独立拉黑 action，这是唯一入口：删除并拉黑）；
- `report`：SnowLuma 无举报接口，返回 `E_UNSUPPORTED`；
- 除 `remark` 外都要 `confirm:true`；失败不重试。

### 2.21 `dy_qq_file` — 发文件（写）

`{kind, contactId, path, name?, base64?}`；白名单 `/sdcard/DSHA`、`/tmp`，默认 ≤8MB；
默认传 `file://<路径>`（实测 SnowLuma 与桥同 mount namespace，能直接读），`base64:true` 才读成 base64；
→ `upload_private_file`/`upload_group_file`；失败不重试。

### 2.22 `dy_qq_video` — 发视频（写）

`{kind, contactId, path, caption?}`；mp4/mov/mkv/webm/avi，≤20MB；
`video` 消息段（base64，实测可发）；**video 必须是消息里唯一段**，caption 会单独先发一条；失败不重试。

### 2.23 `dy_bridge_status` — 只读状态

无参数。返回 mode / opened / health / messages / delivered / deliverFail / agentErrors /
echoSkipped / cardSkipped / groupMentionSkipped / groupFollowUpOpen / sessions / replay /
reconcile / unifiedStats / mirror / media / db 等。

## 3. 配置项（`loadConfig` 合并进 profile 的 `dsh-channel-bridge` config）

| 键 | 默认 | 说明 |
|---|---|---|
| `enabled` | `false` | 插件总开关 |
| `mode` | `'observe'` | observe 不投不发送 / deliver 投递但不发 / send 全开 |
| `host` / `port` / `token` / `tokenFile` | `127.0.0.1` / `3001` / `''` / `/root/.dsh/dsh-channel-bridge.token` | OneBot WS |
| `selfId` | `''` | 登录后自动更新；群门禁缺它会保守不回 |
| `channel` | `'qq'` | 目前唯一渠道 |
| `privateCwd` / `groupCwd` | `/sdcard/DSHA/渠道/qq-私聊`、`/sdcard/DSHA/渠道/qq-群` | 陌生私聊 / 群会话的**父目录**；实际 cwd 为 `<父目录>/<QQ号或群号>`（自动 `mkdir -p`） |
| `cwdRoot` | `/sdcard/DSHA` | `ensureCwd` 白名单根 |
| `agentPreset` | `'standard'` | 新建会话时传给宿主（房间 AGENTS.md / time-context 靠它） |
| `outbound` | `'tool'` | `tool`=她调 dy_say 发；`auto`=自动发（默认不用） |
| `owner.qqIds` | `[]` | 主人 QQ；决定 owner 优先级与「主人卡片不拦」 |
| `say.maxTextChars` / `maxLen` / `maxSegments` / `contactWindowMs` | 2000 / 60 / 4 / 7 天 | QQ 文本长度与拆条 |
| `unified` | `false` | 私聊转 `dyHome.deliver`；群不变 |
| `echoWindowMs` | `3000` | 同 contact 同文本短窗回声去重 |
| `quote.timeoutMs` | `3000`（500–15000） | 引用反查 `get_msg` 的超时；失败只丢引用、不影响正文 |
| `forward.timeoutMs` | `3000`（500–15000） | 合并转发反查 `get_forward_msg` 的超时 |
| `notices.enabled` / `deliver` | true / `['friend_recall','poke','friend_add','group_recall']` | notice 全落库；只有白名单 kind 投进会话（群撤回/拍一拍还要跟话窗口开着） |
| `media.maxVideos` | `2` | 入站视频每次最多落盘几条（0 = 全占位） |
| `images.inline` / `maxInline` | true / 1 | 群聊图片直投：第一张图存进 attachment 服务随消息投给模型（不用她 read_image）；私聊走 dyHome 只收文本，不受此开关影响 |
| `reconcile.enabled/everyMs/count/backoffMs/activeDays` | true / 60000 / 20 / 1h / 7 | 周期对账（私聊） |
| `reconcile.groups` / `groupCount` | `true` / 20 | 群对账开关 / 每群每轮拉多少条（1–100） |
| `handover.sessionId/since/maxChars` | `bfd29a79…` / 2026-11-05 16:50+08 / 20000 | 一次性交接 |
| `rotation.enabled/threshold/ratio/seedMessages` | true / 500000 / 0.7 / 50 | 自动轮换 |
| `mirror.enabled` | `false` | 把已发原文镜像进对话页（纯 tool 模式默认关） |
| `media.enabled/dir/maxBytes/maxImages/maxFiles` | true / `/sdcard/DSHA/渠道/qq/附件` / 20MB / 4 / 3 | 入站附件落盘 |
| `replay.enabled/count/windowMs/onFirstSeen` | true / 20 / 2h / false | 启动补收 |
| `health.heartbeatMs/staleMs/tickMs` | 30000 / 180000 / 15000 | 心跳与硬重置 |
| `context.enabled/limit/maxChars` | true / 10 / 300 | 新会话「上次聊到」 |
| `dbPath` / `modeFile` / `outboxFile` / `log.file` | `/root/.dsh/dsh-channel-bridge/bridge.db` 等 | 见 §5 |
| `group.requireMention` | `true` | 群聊只有 @ 才回（显式 `false` 才全收） |
| `group.contextCount` | `8`（5–10） | 被 @ 时拉最近几条群上下文 |
| `group.followUpMessages` / `followUpIdleMs` | `8` / `300000`（5 分钟） | 跟话窗口：剩余消息数 / 空闲超时 |
| `group.publicBriefLimit` | `3`（1–10） | 群内 `[汐的近况]` 条数上限 |
| `filters.ignoreCards` | `true` | 非主人私聊的纯占位卡片（如邮箱提醒）不投 |
| `filters.ignoreContacts` | `[]` | 可选号码名单兜底（优先按内容判定） |
| `voice.autoTranscribe` | `true` | 语音落 WAV 后自动调 `dyMedia.transcribe({path})`，正文追加 `[语音转写]`（≤300 字），失败保留路径 |

> 0.15.3 起 `group.*` / `filters.*` 已由 `loadConfig` 合并（profile 覆盖生效）；同版本修了
> `health.silentMs/checkMs/warnEveryMs` 的 NaN（默认 1800000/60000/1800000，`num()` 不再产出 NaN）。

## 4. 收发链路

```
QQ ── SnowLuma(OneBot) ── WS ws://127.0.0.1:3001 ── 桥
                                     │  action: send_private_msg / send_group_msg / set_qq_profile …
                                     ▼
实时入站 → 去重(message_id) → 回声短窗 → 占位卡片过滤 → 群门禁(@ / 跟话窗口)
        → 落 bridge.db → 富化附件 + 引用（get_msg 反查 reply）→ unified?(home) : 自己的会话(followup)
```

- **发送**：桥走同一条 WS 的 OneBot action；文本 `auto_escape:true`；图片/语音/头像用 **base64**，
  因为 SnowLuma 看不到我们容器的文件路径。
- **补收**：连上后对每个最近联系人拉 `get_friend_msg_history(count=20)`，只补
  「她最后一次发言之后的未回复主人消息」；自己的消息、已存在的 `message_id` 都跳过；游标只增不减。
- **对账**：每 60s 主动拉历史（不依赖推送）；私聊联系人级错误（非好友 `E_SEND_FAILED`）退避 1h 不刷屏；
  只扫最近 7 天有消息的联系人。
- **群对账（2026-11-10）**：同一轮里对 `kind='group'` 的最近群拉 `get_group_msg_history(count=20)`，
  过滤（有 `message_id`、不是自己发的、`time > last_seen`、`hasMessageId` 为 false）后**必须过 @ 门禁**
  （`shouldDeliverGroup`，和实时入站同一把闸）：@ 她的才投，非 @ 不投、不落库、不推进游标（留给下轮/实时）；
  投递成功才落库（`meta.reconcile=true`）并推进游标；单群拉取失败（超时/被踢）按 `group:<群号>` 独立退避，
  不拖累其它群。`reconcile.groups=false` 可整块关；日志 `群对账：group=… 拉 N / 新 N / 投 N`，失败
  `群对账 group=… 拉历史失败：<code>`（每轮汇总里另有 `群：拉/新/投/门禁跳/失败/退避跳`）。
- **假在线**：`lastMessageAt` 只在真 message 事件更新；连接活着但 ≥30 分钟无消息且有入站历史 → SILENT，
  自动强制重连一次，之后只告警；对账拉到新消息会复位。
- **群 @ 窗口**：@ 命中开窗（剩余 8 条 / 10 分钟 idle），窗口内不 @ 也投；她的群回复续窗；
  用完/超时关窗时，同一时间点各调一次：`dyMemory.saveGroupDigest`（≤10 条摘要）+ `dyMemory.saveGroupTranscript`
  （窗口内**全部**消息，只写记忆库、不注入 home 上下文）；任一失败只 warn、不阻断。
- **群 @ 上下文**：`[汐的近况]`（publicBrief，最多 3 条）→ `[群聊上下文·最近 N 条]` → 本条消息。

## 5. 数据与文件

| 路径 | 内容 |
|---|---|
| `/root/.dsh/dsh-channel-bridge/bridge.db` | SQLite（WAL）：`channel_events`（入/出审计）、`channel_contacts`（联系人/游标）、`channel_sessions`（会话/轮换/用量/交接）、`channel_mirror`（镜像兜底）、`bridge_meta`（`handover.done` 等）、`qq_ops`（改资料/发图/语音/头像审计） |
| `/sdcard/DSHA/渠道/qq/附件/<day>/<msgid>-n.jpg` | 入站图片/文件/语音 |
| `/root/.dsh/dsh-channel-bridge.log` | 运行日志（含 messageId/textHash/投递 tag） |
| `/root/.dsh/dsh-channel-bridge-outbox.log` | 发送失败留底（0600，5MB 轮转） |
| `/root/.dsh/dsh-channel-bridge.token` | WS token（0600） |
| `/root/.dsh/dsh-channel-bridge.json` | 热切换 mode（`{mode:'send'}`） |

## 6. 典型用法

1) **日常私聊**：主人发 QQ → 她收到 → `dy_say` 回；
2) **发图**：`dy_send_image({path:'/sdcard/DSHA/图片/x.png', contactId:'<OWNER_QQ_ID>', caption:'给你看'})`；
3) **先听再发**：`dy_send_voice({path:'/tmp/tts.wav', contactId:'<OWNER_QQ_ID>'})`（TTS 由 dsh-media 生成）；
4) **群里被 @ 接话**：@ 后自动带近况+群上下文；接着聊不用再 @（窗口 8 条/10 分钟）；
5) **换会话**：`dy_bridge_rotate({kind:'private'})` → 新会话带 preset 与最近 50 条原话。

## 7. 边界与已知限制

- **QZone 不可用**（SnowLuma `-3000`），不做；
- **头像/资料是写操作**：必须 `confirm:true`；写失败不重试；头像只支持 png/jpg/jpeg ≤2MB；
- **群聊严格 @**：主人自己没 @ 也不回；`requireMention:false` 才全收；
- **跟话窗口**只在「被 @ 之后」存在，不 @ 且窗口关 → 不投；窗口不会永久开着；
- **unified 只影响私聊**；群聊仍用桥自己的房间；
- **跨容器**：任何本地文件发给 SnowLuma 都必须 base64；`file://` 一定 ENOENT；
- **配置修复（0.15.3，2026-11-07）**：`group.*` / `filters.*` 已并入 `loadConfig`（profile 覆盖生效，缺省走默认）；
  `health.silentMs/checkMs/warnEveryMs` 已补默认（1800000/60000/1800000），`num()` 对 `null/''/undefined/非法值`
  一律回落默认、不再产生 `NaN`；SILENT 判定与 60s 定时检查恢复；
- 带群对账（2026-11-10 起）：群消息也有补收兜底，但**补收不绕过 @ 门禁**；跟话窗口只在实时入站里维护，
  补收按「只投 @」保守处理（窗口内的非 @ 消息补收不投）；
- 摘要/近况依赖 `dyMemory`；交接依赖 `dyHome`；email 依赖 `dyMail`，缺服务时明确报错不退化。

## 8. 测试与同步

```bash
cd /root/.dsh/plugin-src/dsh-channel-bridge
node --test tests/*.test.mjs        # 429 tests（2026-11-10，含群对账 14 条）
sh /sdcard/DSHA/插件开发/自建插件/sync-from-ubuntu.sh   # 同步到 SD 卡（FUSE 下可能失败，改用逐文件 cat 复制）
```

测试全部是 fake 依赖的单元/集成测试，不连真实 WS、不写生产库。
