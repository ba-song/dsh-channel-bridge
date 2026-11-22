# P0-1 Channel Bridge 群成员身份链路审查

- 任务：P0-1 Channel Bridge 群成员身份链路审查
- 角色：Channel Bridge 专项工程智能体
- 基线仓库：`ba-song/dsh-channel-bridge`
- 分支：`fix/p0-1-conversation-context-isolation`
- 目标/实际 HEAD：`3ae4c03f7119c3c798a1d824b8d02bb53ad3544d`（本地 clone 与目标 SHA 一致）
- tree：`3230210b068f9eada8a773b7e6b4941a06dbac9a`
- 验证环境：Node v24.19.0 / npm 11.17.0 / `dsh-channel-bridge@0.18.0`
- 性质：只读代码追踪 + 已运行测试；未修改代码/测试/Schema/DB/配置；未部署/重启/合并；未连接真实 QQ/NapCat；未发送消息。
- 状态：**REJECT**（群成员身份端到端链路仍有 P0 级断点；上下文 scope 修复为 PASS/PARTIAL）

---

## 0. 结论摘要

目标分支已修复 `buildSessionContext` / group fallback / `recentInboundAsc` 的**会话范围**，565/565、103/103、10/10 测试通过。但“真实群成员身份贯穿到 Memory”并未完成，存在以下 P0：

1. **群会话上下文把群 ID 当发言人**：`buildSessionContext` 用 `row.contact` 作为 `who`；群聊时 `row.contact` 是群号，于是输出 `707380948：群成员消息`，真实 `sender_id=member-7` 被忽略。
2. **live buffer 缺 sender 时退化为群名**：`index.js` 用 `parsed.senderName || parsed.contactName || senderId`；缺 `user_id` 时 speaker 变成 `群_<gid>`。
3. **handover 把群消息标成 Owner**：`listInboundSince` 不取 `sender_id`，`collectDbItems` 把所有入站行当 `role:'user'`，`formatHandover` 输出 `[主人]`；群成员消息可被误标 Owner。
4. **group-turn / transcript 仍只传 speaker 名称**：`group-buckets` 只存 `{speaker,text,at}`；`saveGroupTurn`/`saveGroupTranscript` 没有 `external_speaker_id`；Memory 最终无法得到可靠成员 ID。
5. **正常 `get_group_msg_history` 只输出昵称**：内部保留 `senderId`，但最终文本只用 `sender`，同名成员无法区分。
6. **群缺 `user_id` 未 fail-closed**：`parseMessageEvent` 群分支仍返回对象，`senderId=''`，无 `unknown` 标记；既有测试标题“缺 user_id 返回 null”并未覆盖群聊缺 user_id。

**结论**：上下文 scope 隔离 **PASS**；群成员身份链路 **REJECT**；整体 **REJECT/PARTIAL**，不能标记 P0-1 PASS。

---

## 1. 数据流图（实际代码）

```text
OneBot group message
  │
  ├─ lib/parse.js: parseMessageEvent
  │    contactId = group_id
  │    contactName = group_name || 群_<gid>
  │    senderId = user_id (missing → '')
  │    senderName = sender.card || sender.nickname || senderId
  │    (group missing user_id → still returns object)
  │
  ├─ lib/index.js: handle inbound
  │    ├─ store.insertEvent: contact=group_id, sender_id=senderId
  │    ├─ live prompt: senderLabel = senderName only
  │    └─ group buffer: speaker = senderName || contactName || senderId
  │         (missing sender → 群_<gid>)
  │
  ├─ group context (when @)
  │    ├─ normal get_group_msg_history:
  │    │    row.sender = card/nickname/user_id
  │    │    row.senderId = user_id
  │    │    output text uses row.sender (nickname), not senderId
  │    └─ fallback:
  │         recentInboundAsc returns sender_id
  │         router maps sender/senderId = sender_id
  │         output uses sender (ID in fallback)
  │
  ├─ group-turn memory
  │    group-buckets noteMessage: { speaker, text, at }  ← no senderId
  │    group-turn-memory: incoming = [{ speaker, text, at }]
  │    saveGroupTurn: groupId/groupName/incoming/reply/at  ← no external speaker ID
  │
  ├─ transcript/digest
  │    groupDigest normalize: { speaker, text, at }  ← no senderId
  │    saveGroupTranscript: groupId/groupName/at/messageId/header/messages  ← no external speaker ID
  │
  ├─ handover
  │    listInboundSince: id/at/kind/contact/text/message_id  ← no sender_id
  │    collectDbItems: role='user'
  │    formatHandover: [主人]  ← group message misattributed as Owner
  │
  └─ Memory input
       group-turn → episode text with speaker names only
       transcript → raw archive with speakerName only
       no reliable external_speaker_id / speaker_id
```

---

## 2. 逐环节字段变化与源码位置

### 2.1 OneBot 原始事件解析

**代码**：`lib/parse.js:160-220`。

- `senderId = evt.user_id`（缺失 → `''`）。
- 群分支：`contactId = group_id`、`contactName = group_name || 群_<gid>`、`senderId` 保留。
- 群缺 `group_id` → `null`；私聊缺 `senderId` → `null`；**群缺 `senderId` 不返回 null**。

实测：

```text
parsed group missing user_id:
{"contactId":"707380948","senderId":"","senderName":"","contactName":"群_707380948"}
live buffer speaker fallback:
"群_707380948"
```

**结论**：正常群事件 contact/group 与 sender/member 分开 **PASS**；缺 sender 未 fail-closed **REJECT**。

### 2.2 SQLite 存储

**代码**：`lib/store.js:25-40, 210-218, 247-250, 330-345`。

- `channel_events` 有 `sender_id`；`insertEvent` 写入。
- `recentInboundAsc` 现在必须 `channel+kind+contact`，SQL 选取 `sender_id`；缺 scope 返回 `[]`。
- `listInboundSince`（handover 用）**不选取 `sender_id`**。

**结论**：store 层字段与 scope 修复 **PASS**；handover 读取路径丢失 sender_id **REJECT**。

### 2.3 live buffer / prompt

**代码**：`lib/index.js:546,565`；`lib/prompt.js:75-84`。

- buffer：`speaker: parsed.senderName || parsed.contactName || String(parsed.senderId ?? '')`。
- 群 `contactName='群_<gid>'`；缺 sender 时 speaker 变成群名。
- prompt：`senderLabel = parsed.isOwner ? '【主人】' : '' + senderName`；只显示昵称，没有 senderId。

**结论**：live buffer **REJECT**；prompt 身份只显示昵称，**PARTIAL**。

### 2.4 group context

**代码**：`lib/index.js:279-290`、`lib/group-followup.js:132-159`、`lib/context.js:8-42`。

- fallback 已按 `p.channel/kind/contact` 查询，映射 `sender/senderId` 来自 `sender_id` → **PASS**。
- 正常 `get_group_msg_history`：`senderId` 保留在行内，但输出 `who = r.sender`（昵称），不使用 `senderId` → **PARTIAL**。
- `buildSessionContext`：查询已 scope，但 `who = String(row.contact ?? '')`；群聊 `contact` 是群号，输出群 ID 当发言人 → **REJECT**。

实测：

```text
（上次在 QQ 房间里聊到：
08:00 707380948：群成员消息
）
```

即使 `sender_id=member-7`，context 仍显示群号。

### 2.5 group-turn memory

**代码**：`lib/group-buckets.js:29-33`、`lib/group-turn-memory.js:90-128`。

- bucket 只存 `{speaker,text,at}`。
- `incoming` 只传 `{speaker,text,at}`。
- `saveGroupTurn` 参数无 `external_speaker_id`/`senderId`。

**结论**：**REJECT**：最终 Memory 只收到昵称/群名文本，无法恢复成员 ID。

### 2.6 transcript / groupDigest

**代码**：`lib/group-digest.js:50-97`。

- `normalize` 只保留 `{speaker,text,at}`。
- `saveGroupTranscript` 只传 `speaker` 文本；无 `external_speaker_id`；共享 `GROUP_CWD`。
- `saveGroupDigest` 已退役（`DIGEST_RETIRED=true`），当前只有 transcript。

**结论**：**REJECT**：历史归档无法按成员 ID 检索/归属。

### 2.7 handover

**代码**：`lib/store.js:293-305`、`lib/handover.js:114-124,143-152`。

- `listInboundSince` SELECT 不含 `sender_id`，也不含 kind/contact 之外的 speaker。
- `collectDbItems` 把每条入站行当作 `role='user'`。
- `formatHandover` 对所有 user 行输出 `[主人]`。

实测：

```text
listInboundSince keys: [ 'id', 'at', 'kind', 'contact', 'text', 'message_id' ]
08:00 [主人] 群成员消息
```

**结论**：**REJECT（P0）**：群消息被标成 Owner；这是身份冒充，不只是 ID 丢失。

### 2.8 最终 Memory 输入

- `saveGroupTurn`：episode 文本只含 speaker 名称；无 `speaker_id`/external ID。
- `saveGroupTranscript`：raw archive 只含 `speakerName`，无 `external_speaker_id`；当前 Memory `raw_meta` 的 user 行 `speaker_id` 不由该路径可靠填充。
- `handover`：不写 Memory，但注入 home，可能把群消息当 Owner。

**结论**：**REJECT/PARTIAL**：最终 Memory 没有可靠群成员身份；handover 是 Owner 误标路径。

### 2.9 其他渠道

- 本分支源码只覆盖 `private`/`group` 解析；其他渠道仅在 `channel` 配置字段层面，未发现同类的群成员 ID 处理。
- 其他渠道的同类字段丢失 **NOT_RUN/无源码证据**，不在本报告下结论。

---

## 3. 身份丢失点清单（按风险）

### P0

1. `buildSessionContext` 群 context 用 `row.contact`（群号）当 `who`；真实 `sender_id` 被忽略。`lib/context.js:31`。
2. live buffer 缺 sender 退化 `群_<gid>`；group-turn/transcript 继承。`lib/index.js:546,565`。
3. handover 不取 `sender_id`，所有 user 行标 `[主人]`；群成员消息可被误标 Owner。`lib/store.js:293-305`、`lib/handover.js:114-124,143-152`。
4. group-turn/transcript 只传 speaker 名称，不传 external member ID；最终 Memory 无法恢复成员身份。`lib/group-buckets.js:29-33`、`lib/group-turn-memory.js:122-127`、`lib/group-digest.js:56-88`。
5. 群缺 `user_id` 未 fail-closed，`senderId=''` 仍可进入 buffer/Memory。`lib/parse.js:199-219`。
6. 正常 group history 输出只用昵称；同名成员无法区分。`lib/group-followup.js:139-157`。

### P1

7. `message.source` 不带 `senderId`/`groupId`/`external_speaker_id`，下游 Memory/Persona 无法从投递体取得成员身份。`lib/message.js:10-35`。
8. prompt 群发言人只显示昵称，不显示稳定 ID；同名/改名时无法区分。`lib/prompt.js:75-84`。
9. `listInboundSince` 的字段缺失也影响 handover 之外的潜在读取者。`lib/store.js:293-305`。
10. `notice` actor/operator 未分离（群撤回/禁言/拍一拍），可能把操作者/目标混为同一人。`lib/index.js:398-447`、`lib/notice.js:78-135`（相关但非本轮主链）。

### P2

11. forward/quote 展示层只显示名字，结构字段未进入最终文本；多跳转发/引用作者有歧义。`lib/forward.js`、`lib/quote.js`。
12. 其他渠道同类问题未验证（NOT_RUN）。

---

## 4. 最小修复方案（设计）

### 4.1 Channel Bridge

1. **parse**：群消息缺 `user_id` 时返回 `senderId=null`/`senderName=''`/`speakerUnknown=true`；或按任务安全规则直接拒绝投递。不得 `senderId=''` 后让 downstream fallback。
2. **live buffer**：增加 `senderId`/`externalSpeakerId` 字段；speaker 只作显示名，缺 ID 时用 `unknown` 标记，不得 `contactName`。
3. **prompt**：群标签可显示昵称，但结构化 source 必须带 `external_speaker_id`。
4. **context**：`who = row.sender_id || '[unknown]'`，群聊不得用 `row.contact`（群号）当发言人；私聊才可用 contact。
5. **group-followup**：正常 history 行保留 `senderId`；输出可用 `昵称(成员ID)` 或 `[成员ID]`；同名不同 ID 不合并。
6. **group-buckets/group-turn**：bucket 存 `senderId`；`saveGroupTurn` 增加 `external_speaker_id`（以及 conversation/group）。
7. **groupDigest/transcript**：normalize 保留 `speakerId`；`saveGroupTranscript` 传 `external_speaker_id`/group_id/source。
8. **handover**：`listInboundSince` SELECT 增加 `sender_id`、kind/contact；`formatHandover` 按 kind/sender 标注，群消息用 `[群<gid> 成员<id>]` 或 `[未知成员]`，不得统一 `[主人]`；Owner 只用于私聊 owner。
9. **message.source**：补 `senderId`/`groupId`/`externalSpeakerId`（与合同 R4 Envelope 对齐）。
10. **SQL/读取**：所有历史读取同时带 channel/kind/contact + sender_id；缺 scope 返回空。

### 4.2 Memory

- `saveGroupTurn`/`saveGroupTranscript` 接收并持久化 `external_speaker_id`；canonical `speaker_id` 由 Memory 映射，不能由 Bridge 决定。
- 群实体 ID 只作 group/scope，不作 speaker；缺 ID -> `speaker_id=null`/`unknown`。
- 遵守 R4 current/history/legacy 与 confidence 默认；不得用昵称/群名补 ID。

### 4.3 Persona

- 不参与群成员 canonical 映射；只负责 Owner/Self canonical identity。
- 不得把群成员 ID 当 Self/Owner；缺 ID 保持 unknown。

### 4.4 合同边界

- Channel 提供 `external_speaker_id`/`group_id`/`conversation_id`/`source_id`/event_time；
- Memory 唯一写 canonical speaker/experiencer/evidence；
- Persona 只验证 Self/Owner；
- 任何一方不得用群 ID/昵称/群名冒充分钟成员。

---

## 5. 端到端测试矩阵

| ID | 场景 | 期望 | 当前结果 |
|---|---|---|---|
| T1 | 正常群事件 `group_id=G, user_id=M` | `contactId=G`、`senderId=M` | **PASS** |
| T2 | 群事件缺 `user_id` | `unknown`/fail-closed；不得 `群_<gid>` speaker | **REJECT**（parse 返回空 sender，buffer 退化群名） |
| T3 | 同群两个同名成员 M1/M2 | 两条消息 speaker 可区分（ID 保留） | **REJECT**（历史输出只昵称） |
| T4 | 群 A 与群 B | 上下文/摘要不互混 | **PASS**（context/store/fallback scope 测试） |
| T5 | 私聊与群聊同号 | 不互混 | **PASS**（context/store 测试） |
| T6 | 群消息进入 group-turn | Memory 输入含 `external_speaker_id` | **REJECT**（只 speaker 名） |
| T7 | 群消息进入 transcript | transcript 含 `group_id`/`external_speaker_id` | **REJECT**（只 speakerName/shared cwd） |
| T8 | 群会话新 context | `who` 是成员 ID/unknown，不是群号 | **REJECT**（输出群号） |
| T9 | handover 群消息 | 不标 `[主人]`；标成员/未知 | **REJECT**（输出 `[主人]`） |
| T10 | 缺 conversation scope | context 空、store 空 | **PASS** |
| T11 | 群 history normal vs fallback | 两条路径都保留成员 ID | **PARTIAL**（fallback ID，normal 只昵称） |
| T12 | 其他渠道 | 只在有源码证据时报告 | **NOT_RUN** |

测试命令：

```bash
cd /tmp/p01-verify
npm test
node --test tests/context.test.mjs tests/group-followup.test.mjs tests/group-turn-memory.test.mjs tests/group-digest.test.mjs tests/store.test.mjs tests/router.test.mjs tests/multi-session.test.mjs tests/sessions.test.mjs tests/handover.test.mjs tests/public-brief.test.mjs tests/handoff-brief.test.mjs
node --test tests/parse.test.mjs
```

结果：565/565、103/103、10/10 全部通过，但上述测试未覆盖 T2/T3/T6/T7/T8/T9 的群身份端到端断言；**测试通过不等于身份链 PASS**。

---

## 6. 结论

| 项目 | 状态 |
|---|---|
| HEAD/依赖/全量测试 | **PASS**（565/565、103/103、10/10） |
| 会话 scope 隔离（context/store/fallback） | **PASS** |
| 正常 parse 的 group/member 字段分离 | **PASS** |
| 缺 user_id 的群消息 fail-closed | **REJECT** |
| group context 发言人 | **REJECT**（群号当 who） |
| live buffer/prompt 群身份 | **REJECT/PARTIAL** |
| group-turn/transcript Memory 身份 | **REJECT** |
| handover 群消息归属 | **REJECT**（标 Owner） |
| 正常 group history 同名成员 | **PARTIAL/REJECT**（只昵称） |
| 其他渠道 | **NOT_RUN** |
| 总体 P0-1 群成员身份链 | **REJECT** |

**不能标记 P0-1 PASS。** 目标分支只完成了 scope 隔离与 `sender_id` 存储/fallback 的部分修复；真实群成员身份在 context、live buffer、group-turn、transcript、handover 和最终 Memory 输入中仍丢失或冒认。等待 GPT 负责人复核，本轮不实施修复。

---

## 7. 未执行 / 边界

- 未修改代码/测试/Schema/DB/配置；未部署/重启/合并；未操作真实 QQ/NapCat/生产 DB/设备。
- 未运行真实群 history/真实消息；未验证其他渠道同类问题（NOT_RUN）。
- 未把 Memory/Persona 修改合并到本任务；只给职责边界建议。
- 所有测试/探针使用 `/tmp/p01-verify` 临时 clone 与内存 SQLite。
