window.__ModuleLoader__.load({
	id: "dsh-channel-bridge",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react_jsx_runtime = require("react/jsx-runtime");
		let _deepseek_ai_dsh_client_ui_primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		//#region locales
		/** English copy. */
		const en = {
			nav: "Xi",
			title: "Xi's settings",
			subtitle: "Save, then restart DSH for changes to take effect.",
			summary: "How Xi talks, remembers, feels, and acts on her own.",
			cardTalk: "Speaking and messages",
			cardGroup: "Group chats",
			cardMemory: "Memory",
			cardPersona: "Mood and personality",
			cardAutonomy: "Life and initiative",
			cardDouyin: "Douyin",
			mode: "Connection mode",
			modeHint: "Watch only: she sees messages but does not reply; deliver only: messages reach her room but are never actually sent; real sends: she can speak on QQ.",
			modeObserve: "Watch only",
			modeDeliver: "Deliver to room",
			modeSend: "Allow real sends",
			sayMaxLen: "Most characters per message",
			sayMaxLenHint: "Anything longer is split into several messages, so one long block never floods the chat.",
			requireMention: "In groups, reply only when @-mentioned",
			requireMentionHint: "Turn this off and she may pick up every line in a group, which floods the chat.",
			followUpMessages: "Replies after being @-mentioned",
			followUpMessagesHint: "After being called, she can keep replying a few times without being @-mentioned each time.",
			followUpWindow: "Follow-up window in minutes",
			followUpWindowHint: "How long after being called she still counts as in the conversation; past that, @ her again.",
			memoryRecord: "Remember what we talk about",
			memoryRecordHint: "When off, she only remembers what you explicitly ask her to remember.",
			memoryInject: "Bring up things she remembers",
			memoryInjectHint: "When off, she will not mention the past on her own unless you ask.",
			memoryTtl: "How many days group memories are kept",
			memoryTtlHint: "Expired ones are forgotten, so old group chats do not pile up.",
			memoryClarity: "Daily clarity decay",
			memoryClarityHint: "vivid→clear→fuzzy→trace like a human; dry-run by default.",
			lifeDrivesExt: "Extended 9 drives",
			lifeDrivesExtHint: "Off by default; rest/approval/affiliation/rebellion/order.",
			lifePauseAll: "Pause all autonomous actions",
			lifePauseAllHint: "Off by default. Takes effect after restart; the HUD also has an immediate pause/resume button.",
			lifePurpose: "Purpose engine bonus",
			lifePurposeHint: "Off by default; gives a small score bonus to actions matching a purpose seed.",
			lifeNotifyTrigger: "Phone notification wake-up",
			lifeNotifyTriggerHint: "Requires the DSHA notification forwarder app and notification access. Off by default.",
			lifeDeviceTrigger: "Screen-change trigger",
			lifeDeviceTriggerHint: "Poll accessibility dump; at most once per 30 min. Off by default.",
			groupSocial: "Group social judgment",
			groupSocialHint: "Let her decide whether to speak in group; off by default.",
			personaInject: "Personality injection",
			personaInjectHint: "Full: her character and history come along; brief: only the essentials; off: she behaves like a plain assistant.",
			personaFull: "Full",
			personaBrief: "Brief",
			personaOff: "Off",
			personaMood: "Her mood changes with the chat",
			personaMoodHint: "When off, her mood no longer rises and falls with the conversation.",
			personaThreshold: "Mood sensitivity",
			personaAppend: "Persona add-on (appended after her persona)",
			personaAppendHint: "This never replaces her persona file; it is appended after persona.md and takes effect together. Leave empty to keep the file alone. Restart DSH after saving.",
			personaAppendPlaceholder: "e.g. Don\'t play it cool; say it when you are down.",
			personaThresholdHint: "Higher means only very clear words move her.",
			personaAppraisal: "Use event appraisal for mood",
			personaAppraisalHint: "On: a small LLM appraises ordinary messages. Off: keyword rules only.",
			personaGrievance: "Track unresolved conflicts",
			personaGrievanceHint: "Off by default; when on she may bring up things later.",
			personaVirtue: "Inject personality axes",
			personaVirtueHint: "Off by default; injects stubborn/gentle/proactive/restrained.",
			autonomyEnabled: "Let her decide to do things on her own",
			autonomyEnabledHint: "When off, she only moves when called.",
			autonomyHome: "Let her wake up in her own room",
			autonomyHomeHint: "When off, she will not wake up by herself; only when you call her.",
			autonomyMin: "Shortest wait between waking up (minutes)",
			autonomyMax: "Longest wait between waking up (minutes)",
			autonomyIntervalHint: "How often she wakes up to look around; the further apart the two numbers, the more random it is.",
			douyinEnabled: "Let her browse Douyin",
			douyinQuota: "Most videos per day",
			douyinQuotaHint: "She stops at the limit and resumes the next day.",
			overridden: "Changed",
			reset: "Reset to default",
			readOnly: "These settings are read-only here.",
			unavailable: "The settings service is not ready yet; open this page again in a moment.",
			save: "Save",
			saving: "Saving…",
			saveFailed: "Nothing was saved; your values are still here, so adjust them and save again.",
			blockSaveFailed: "{block} settings were not saved: {reason}",
			reasonRejected: "the server did not accept the change",
			reasonUnavailable: "the settings service is unavailable",
			reasonReadOnly: "these settings are read-only",
			reasonInvalid: "some values are not filled in correctly",
			blockChannel: "Speaking and messages, group chats",
			invalidMaxLen: "Enter 10 or more.",
			invalidFollowUpMessages: "Enter 0 or more.",
			invalidWindow: "Enter at least 1 minute.",
			invalidTtl: "Enter a number from 1 to 3650.",
			invalidThreshold: "Enter a number from 0 to 100.",
			invalidAutonomy: "Enter a number from 15 to 1440 minutes.",
			invalidQuota: "Enter a number from 1 to 100.",
			invalidNumber: "Enter a number, or leave blank to use the default.",
			savedHint: "Saved. Restart DSH for it to take effect."
		};
		/** Simplified Chinese copy. */
		const zh = {
			nav: "汐",
			title: "汐的状态与设置",
			subtitle: "上面是实时状态；下面是设置，保存后重启 DSH 生效。",
			summary: "汐在 QQ 里怎么说话、怎么记、怎么想、怎么自己动。",
			cardTalk: "说话与消息",
			cardGroup: "群聊",
			cardMemory: "记忆",
			cardPersona: "情绪与人格",
			cardAutonomy: "生活与主动",
			cardDouyin: "抖音",
			mode: "连接模式",
			modeHint: "只观察：她能看到消息但不回；只投递：消息会进她的房间但她不会真的发出去；允许真发：她能在 QQ 上说话",
			modeObserve: "只观察",
			modeDeliver: "只投递到房间",
			modeSend: "允许真的发到 QQ",
			sayMaxLen: "一条消息最多写多少字",
			sayMaxLenHint: "超过就会自动拆成几条发，避免一大段刷屏",
			requireMention: "群里只在被 @ 的时候回",
			requireMentionHint: "关掉后，群里每句话都可能被她接，容易刷屏",
			followUpMessages: "被 @ 之后还能接几句话",
			followUpMessagesHint: "被叫到之后，她可以继续接几句，不用每句都 @",
			followUpWindow: "跟话窗口几分钟",
			followUpWindowHint: "被叫到后多久内还算“在聊”；超过这个时间就要重新 @ 她",
			memoryRecord: "自动记住聊到的事",
			memoryRecordHint: "关掉后，她只会记住你明确让她记的",
			memoryInject: "聊天时带上她记得的事",
			memoryInjectHint: "关掉后，她不会主动提起以前的事，除非你问",
			memoryTtl: "群里的记忆保留多少天",
			memoryTtlHint: "过期后自动忘掉，旧群聊不会一直占着",
			memoryClarity: "记忆像人一样变模糊",
			memoryClarityHint: "清晰度每天最多降一档；默认只演练、不真改记忆。",
			lifeDrivesExt: "更多驱力（9 项）",
			lifeDrivesExtHint: "默认关；开启后她会更在意休息、被认可、靠近、反抗和秩序。",
			lifePauseAll: "暂停全部自主行动",
			lifePauseAllHint: "默认关；保存并重启后生效。HUD 里也有即时暂停/恢复按钮。",
			lifePurpose: "让目的影响行动",
			lifePurposeHint: "默认关；开启后符合当前目的的候选行动会更容易被选中。",
			lifeNotifyTrigger: "手机通知触发",
			lifeNotifyTriggerHint: "需要先装「DSHA 通知转发」App 并给通知使用权；默认关。",
			lifeDeviceTrigger: "屏幕变化时叫醒她",
			lifeDeviceTriggerHint: "手机画面变化时可能主动醒来；30 分钟最多一次，默认关。",
			groupSocial: "群聊先判断再说话",
			groupSocialHint: "默认关；开启后她会先判断要不要接、最多说几条。",
			personaInject: "人格注入",
			personaInjectHint: "完整：她的性格和经历都带上；简短：只带要点；关闭：像普通助手",
			personaFull: "完整",
			personaBrief: "简短",
			personaOff: "关闭",
			personaMood: "会根据聊天改变心情",
			personaMoodHint: "关掉后情绪不再随对话起伏",
			personaThreshold: "情绪波动的门槛",
			personaThresholdHint: "越高，只有很明显的话才会影响她",
			personaAppraisal: "用事件评估决定情绪",
			personaAppraisalHint: "开：每轮普通消息由小模型评估；关：只认关键词规则。",
			personaGrievance: "记录没说开的矛盾",
			personaGrievanceHint: "默认关；开了才会自动记账，避免她变成爱翻旧账。",
			personaVirtue: "注入性格底色",
			personaVirtueHint: "默认关；开了会注入嘴硬/温柔/主动/克制四轴。",
			personaAppend: "人格补充（加在她原有人格后面）",
			personaAppendHint: "这里写的话不会覆盖她原本的人格，只会加在 persona.md 后面一起生效。留空表示不改；保存后重启 DSH 生效。",
			personaAppendPlaceholder: "比如：别端着；闷了就说；鱼味少一点，人味多一点。",
			autonomyEnabled: "允许她自己决定做点事",
			autonomyEnabledHint: "关掉后她只在被叫到时才动",
			autonomyHome: "允许她在自己的房间醒来",
			autonomyHomeHint: "关掉后她不会自己醒来，只在你叫她时动",
			autonomyMin: "在自己房间醒来的最短间隔（分钟）",
			autonomyMax: "在自己房间醒来的最长间隔（分钟）",
			autonomyIntervalHint: "她多久醒一次看看；两个数拉得越开越随机",
			douyinEnabled: "允许她刷抖音",
			douyinQuota: "每天最多看几条",
			douyinQuotaHint: "到量就停，第二天恢复",
			overridden: "已改过",
			reset: "恢复默认",
			readOnly: "当前设置是只读的，改不了。",
			unavailable: "设置服务还没加载好，暂时改不了；稍后再打开这一页试试。",
			save: "保存",
			saving: "保存中…",
			saveFailed: "没保存上，刚填的内容还在，改一改再点保存。",
			blockSaveFailed: "{block}的设置没保存上：{reason}",
			reasonRejected: "服务器没有接受这次修改",
			reasonUnavailable: "设置服务暂时不可用",
			reasonReadOnly: "当前设置是只读的",
			reasonInvalid: "有还没填对的内容",
			blockChannel: "消息和群聊",
			invalidMaxLen: "请填 10 以上的数字。",
			invalidFollowUpMessages: "请填 0 以上的数字。",
			invalidWindow: "请填 1 分钟以上的数字。",
			invalidTtl: "请填 1 到 3650 之间的数字。",
			invalidThreshold: "请填 0 到 100 之间的数字。",
			invalidAutonomy: "请填 15 到 1440 分钟之间的数字。",
			invalidQuota: "请填 1 到 100 之间的数字。",
			invalidNumber: "请填数字；留空表示使用默认值。",
			savedHint: "已保存，重启 DSH 后生效"
		};
		/** The form frame's copy, read from this page's dictionary. */
		function formLabels(t) {
			return {
				unavailable: t("unavailable"),
				readOnly: t("readOnly"),
				saveFailed: t("saveFailed"),
				save: t("save"),
				saving: t("saving")
			};
		}
		//#endregion
		//#region fields
		/** One minute in the milliseconds the stored value uses. */
		const MINUTE_MS = 60 * 1000;
		/** Values the runtime accepts for `mode` (see lib/config.js MODES). */
		const MODE_VALUES = ["observe", "deliver", "send"];
		/** Reads one nested config value; missing containers read as undefined. */
		function readPath(root, path) {
			let current = root;
			for (const key of path) {
				if (current === null || typeof current !== "object") return void 0;
				current = current[key];
			}
			return current;
		}
		/** Reports whether one nested key exists in a layer (presence means "overridden"). */
		function hasPath(root, path) {
			if (path.length === 0) return root !== void 0;
			const parent = readPath(root, path.slice(0, -1));
			if (Array.isArray(parent)) return Number(path[path.length - 1]) < parent.length;
			if (parent === null || typeof parent !== "object") return false;
			return path[path.length - 1] in parent;
		}
		/** Formats a stored boolean for the switch's staged text. */
		function formatBool(value) {
			return typeof value === "boolean" ? String(value) : "";
		}
		/** Parses a switch draft; only the two strings the switch itself writes are accepted. */
		function parseBool(text) {
			const trimmed = text.trim();
			if (trimmed === "") return { kind: "clear" };
			if (trimmed === "true") return { kind: "set", value: true };
			if (trimmed === "false") return { kind: "set", value: false };
			return void 0;
		}
		/**
		 * Number conversion for one field.
		 *
		 * The stored value is what the runtime reads; the shown value is what the
		 * user thinks in. `scale` multiplies the stored value for display (the
		 * mood threshold lives as 0..1 and shows as 0..100), and `unit: "minutes"`
		 * divides a stored millisecond value by one minute. Bounds apply to the
		 * shown number, so an invalid draft names the unit the user sees.
		 */
		function numberConversion(spec) {
			const min = spec.min ?? 0;
			const max = spec.max ?? Number.POSITIVE_INFINITY;
			const toShown = (value) => {
				if (typeof value !== "number" || !Number.isFinite(value)) return "";
				const shown = spec.unit === "minutes" ? value / MINUTE_MS : spec.scale === void 0 ? value : value * spec.scale;
				return String(Number(shown.toFixed(3)));
			};
			const parse = (text) => {
				const trimmed = text.trim();
				if (trimmed === "") return { kind: "clear" };
				const shown = Number(trimmed);
				if (!Number.isFinite(shown) || shown < min || shown > max) return void 0;
				const stored = spec.unit === "minutes" ? Math.round(shown * MINUTE_MS) : spec.scale === void 0 ? shown : shown / spec.scale;
				return { kind: "set", value: stored };
			};
			return { format: toShown, parse };
		}
		/** Adds the field key and the draft conversion a control needs. */
		function normalizeField(spec) {
			const field = { ...spec, key: spec.path.join(".") };
			if (spec.kind === "segmented") {
				const values = spec.options.map((option) => option.value);
				return {
					...field,
					format: (value) => typeof value === "string" ? value : "",
					parse: (text) => {
						const trimmed = text.trim();
						if (trimmed === "") return { kind: "clear" };
						return values.includes(trimmed) ? { kind: "set", value: trimmed } : void 0;
					}
				};
			}
			if (spec.kind === "switch") return { ...field, format: formatBool, parse: parseBool };
			if (spec.kind === "number") return { ...field, ...numberConversion(spec) };
			if (spec.kind === "text") return {
				...field,
				format: (value) => typeof value === "string" ? value : "",
				parse: (text) => String(text ?? "").trim() === "" ? { kind: "clear" } : { kind: "set", value: String(text) }
			};
			throw new Error(`xike settings: unknown field kind ${String(spec.kind)}`);
		}
		/**
		 * The cards this page exposes, in order. A card names the settings
		 * namespace it edits, so several cards may share one namespace (speaking
		 * and group chats both live in `channel-bridge`) and still save as one
		 * `mutate` for that namespace.
		 */
		const CARD_SPECS = [
			{
				id: "talk",
				ns: "channel-bridge",
				title: "cardTalk",
				fields: [
					{
						path: ["mode"],
						kind: "segmented",
						label: "mode",
						hint: "modeHint",
						options: [
							{ value: "observe", label: "modeObserve" },
							{ value: "deliver", label: "modeDeliver" },
							{ value: "send", label: "modeSend" }
						]
					},
					{
						path: ["say", "maxLen"],
						kind: "number",
						label: "sayMaxLen",
						hint: "sayMaxLenHint",
						invalid: "invalidMaxLen",
						min: 10
					}
				]
			},
			{
				id: "group",
				ns: "channel-bridge",
				title: "cardGroup",
				fields: [
					{
						path: ["group", "requireMention"],
						kind: "switch",
						label: "requireMention",
						hint: "requireMentionHint"
					},
					{
						path: ["group", "social", "enabled"],
						kind: "switch",
						label: "groupSocial",
						hint: "groupSocialHint"
					},
					{
						path: ["group", "followUpMessages"],
						kind: "number",
						label: "followUpMessages",
						hint: "followUpMessagesHint",
						invalid: "invalidFollowUpMessages",
						min: 0
					},
					{
						path: ["group", "followUpIdleMs"],
						kind: "number",
						unit: "minutes",
						label: "followUpWindow",
						hint: "followUpWindowHint",
						invalid: "invalidWindow",
						min: 1
					}
				]
			},
			{
				id: "memory",
				ns: "memory-core",
				title: "cardMemory",
				fields: [
					{
						path: ["memoryRecordEnabled"],
						kind: "switch",
						label: "memoryRecord",
						hint: "memoryRecordHint"
					},
					{
						path: ["memoryInjectEnabled"],
						kind: "switch",
						label: "memoryInject",
						hint: "memoryInjectHint"
					},
					{
						path: ["clarity", "enabled"],
						kind: "switch",
						label: "memoryClarity",
						hint: "memoryClarityHint"
					},
					{
						path: ["groupMemory", "ttlDays"],
						kind: "number",
						label: "memoryTtl",
						hint: "memoryTtlHint",
						invalid: "invalidTtl",
						min: 1,
						max: 3650
					}
				]
			},
			{
				id: "persona",
				ns: "persona-core",
				title: "cardPersona",
				fields: [
					{
						path: ["inject", "mode"],
						kind: "segmented",
						label: "personaInject",
						hint: "personaInjectHint",
						options: [
							{ value: "full", label: "personaFull" },
							{ value: "brief", label: "personaBrief" },
							{ value: "off", label: "personaOff" }
						]
					},
					{
						path: ["emotion", "ingestEnabled"],
						kind: "switch",
						label: "personaMood",
						hint: "personaMoodHint"
					},
					{
						path: ["emotion", "threshold"],
						kind: "number",
						scale: 100,
						label: "personaThreshold",
						hint: "personaThresholdHint",
						invalid: "invalidThreshold",
						min: 0,
						max: 100
					},
					{
						path: ["appraisal", "enabled"],
						kind: "switch",
						label: "personaAppraisal",
						hint: "personaAppraisalHint"
					},
					{
						path: ["grievance", "enabled"],
						kind: "switch",
						label: "personaGrievance",
						hint: "personaGrievanceHint"
					},
					{
						path: ["virtue", "enabled"],
						kind: "switch",
						label: "personaVirtue",
						hint: "personaVirtueHint"
					},
					{
						path: ["appendText"],
						kind: "text",
						label: "personaAppend",
						hint: "personaAppendHint",
						placeholder: "personaAppendPlaceholder",
						rows: 5
					}
				]
			},
			{
				id: "autonomy",
				ns: "autonomy",
				title: "cardAutonomy",
				fields: [
					{
						path: ["enabled"],
						kind: "switch",
						label: "autonomyEnabled",
						hint: "autonomyEnabledHint"
					},
					{
						path: ["home", "enabled"],
						kind: "switch",
						label: "autonomyHome",
						hint: "autonomyHomeHint"
					},
					{
						path: ["home", "minIntervalMin"],
						kind: "number",
						label: "autonomyMin",
						hint: "autonomyIntervalHint",
						invalid: "invalidAutonomy",
						min: 15,
						max: 1440
					},
					{
						path: ["home", "maxIntervalMin"],
						kind: "number",
						label: "autonomyMax",
						invalid: "invalidAutonomy",
						min: 15,
						max: 1440
					},
					{
						path: ["drives", "extended"],
						kind: "switch",
						label: "lifeDrivesExt",
						hint: "lifeDrivesExtHint"
					},
					{
						path: ["pauseAll"],
						kind: "switch",
						label: "lifePauseAll",
						hint: "lifePauseAllHint"
					},
					{
						path: ["purpose", "enabled"],
						kind: "switch",
						label: "lifePurpose",
						hint: "lifePurposeHint"
					},
					{
						path: ["triggers", "notification", "enabled"],
						kind: "switch",
						label: "lifeNotifyTrigger",
						hint: "lifeNotifyTriggerHint"
					},
					{
						path: ["triggers", "device", "enabled"],
						kind: "switch",
						label: "lifeDeviceTrigger",
						hint: "lifeDeviceTriggerHint"
					}
				]
			},
			{
				id: "douyin",
				ns: "douyin",
				title: "cardDouyin",
				fields: [
					{
						path: ["enabled"],
						kind: "switch",
						label: "douyinEnabled"
					},
					{
						path: ["dailyQuota"],
						kind: "number",
						label: "douyinQuota",
						hint: "douyinQuotaHint",
						invalid: "invalidQuota",
						min: 1,
						max: 100
					}
				]
			}
		];
		/** The card declarations with their field conversions resolved. */
		const CARDS = CARD_SPECS.map((card) => ({ ...card, fields: card.fields.map(normalizeField) }));
		/** What a failed write calls its block, by namespace. */
		const NS_LABELS = {
			"channel-bridge": "blockChannel",
			"memory-core": "cardMemory",
			"persona-core": "cardPersona",
			autonomy: "cardAutonomy",
			douyin: "cardDouyin"
		};
		/**
		 * Stages one namespace's edits over the shared config form and writes them
		 * on save.
		 *
		 * Same contract as the shared `SettingsFormModel` (staged text, effective
		 * value = user layer over base over schema default, one `mutate` per save,
		 * revision-fenced against the read baseline), extended to nested config
		 * paths and to the switch/minutes/percent conversions the cards show.
		 */
		var NamespaceForm = class {
			ns;
			scope;
			specs;
			staged = new Map();
			listeners = new Set();
			baseline;
			unsubscribe;
			saving = false;
			warned = new Set();
			/** @param scope - the shared configuration form for this namespace. */
			constructor(ns, scope, specs) {
				this.ns = ns;
				this.scope = scope;
				this.specs = new Map(specs.map((spec) => [spec.key, spec]));
				this.unsubscribe = scope.subscribe(() => {
					this.publish();
				});
			}
			snapshotOf() {
				return this.scope.getSnapshot();
			}
			ready() {
				return this.snapshotOf().status === "ready";
			}
			writable() {
				return this.snapshotOf().writable;
			}
			sectionValue(spec) {
				return readPath(this.snapshotOf().value, spec.path);
			}
			baseValue(spec) {
				return readPath(this.snapshotOf().base, spec.path);
			}
			stored(spec) {
				return hasPath(this.snapshotOf().user, spec.path);
			}
			/** Read the staged or effective state of every field the Host actually serves. */
			views(specs) {
				const views = [];
				for (const spec of specs) {
					if (this.sectionValue(spec) === void 0) {
						this.warnMissing(spec);
						continue;
					}
					views.push(this.view(spec));
				}
				return views;
			}
			/** A field the namespace does not carry is skipped rather than drawn empty; say so once. */
			warnMissing(spec) {
				if (this.warned.has(spec.key)) return;
				this.warned.add(spec.key);
				if (typeof console !== "undefined" && typeof console.warn === "function") console.warn(`[xike-settings] ${this.ns}:${spec.key} 不在服务端设置里，已跳过`);
			}
			/** Read one control's state. */
			view(spec) {
				const staged = this.staged.get(spec.key);
				let text;
				let overridden;
				let invalid = false;
				if (staged === void 0) {
					text = spec.format(this.sectionValue(spec));
					overridden = this.stored(spec);
				} else {
					text = staged.text;
					overridden = false;
					if (!staged.clear) {
						const write = spec.parse(staged.text);
						overridden = write !== void 0 && write.kind === "set";
						invalid = write === void 0;
					}
				}
				return {
					key: spec.key,
					kind: spec.kind,
					label: spec.label,
					hint: spec.hint,
					invalidLabel: spec.invalid,
					text,
					overridden,
					invalid,
					checked: text === "true",
					options: spec.options
				};
			}
			/** Stage one control's draft. */
			edit(key, text) {
				this.stage(key, {
					text,
					clear: false
				});
			}
			/** Stage a clear back to the composition layer. */
			reset(key) {
				const spec = this.spec(key);
				this.stage(key, {
					text: spec.format(this.baseValue(spec)),
					clear: true
				});
			}
			stage(key, edit) {
				this.spec(key);
				this.baseline ??= this.snapshotOf();
				this.staged.set(key, edit);
				this.publish();
			}
			/** Every staged edit a save would write; invalid drafts block the save. */
			plan() {
				const plan = [];
				for (const [key, staged] of this.staged) {
					const spec = this.spec(key);
					if (staged.clear) {
						if (this.stored(spec)) plan.push({
							key,
							op: {
								op: "unset",
								path: spec.path
							}
						});
						continue;
					}
					if (staged.text === spec.format(this.sectionValue(spec))) continue;
					const write = spec.parse(staged.text);
					if (write === void 0) plan.push({ key });
					else if (write.kind === "clear") plan.push({
						key,
						op: {
							op: "unset",
							path: spec.path
						}
					});
					else plan.push({
						key,
						op: {
							op: "set",
							path: spec.path,
							value: write.value
						}
					});
				}
				return plan;
			}
			dirty() {
				return this.plan().length > 0;
			}
			invalid() {
				return this.plan().some((item) => item.op === void 0);
			}
			hasInvalid() {
				return this.invalid();
			}
			/**
			 * Write this namespace's staged edits, then re-seed from what the Host
			 * accepted. A failed write keeps its drafts, so the user can correct
			 * them instead of retyping.
			 * @returns settlement with a reason key or the thrown message.
			 */
			async save() {
				const plan = this.plan();
				if (this.saving) return { ok: false, reasonKey: "reasonRejected" };
				if (plan.some((item) => item.op === void 0)) return { ok: false, reasonKey: "reasonInvalid" };
				if (!this.ready()) return { ok: false, reasonKey: "reasonUnavailable" };
				if (!this.writable()) return { ok: false, reasonKey: "reasonReadOnly" };
				const ops = plan.flatMap((item) => item.op === void 0 ? [] : [item.op]);
				if (!ops.length) return { ok: true };
				this.saving = true;
				this.publish();
				try {
					const landed = await this.scope.mutate(ops, this.baseline?.revision);
					if (!landed) return { ok: false, reasonKey: "reasonRejected" };
					this.staged.clear();
					this.baseline = void 0;
					return { ok: true };
				} catch (error) {
					return {
						ok: false,
						message: error?.message === void 0 ? String(error) : String(error.message)
					};
				} finally {
					this.saving = false;
					this.publish();
				}
			}
			discard() {
				if (this.staged.size === 0) return;
				this.staged.clear();
				this.baseline = void 0;
				this.publish();
			}
			spec(key) {
				const spec = this.specs.get(key);
				if (spec === void 0) throw new Error(`xike settings page has no field ${key}`);
				return spec;
			}
			subscribe(listener) {
				this.listeners.add(listener);
				return () => {
					this.listeners.delete(listener);
				};
			}
			publish() {
				for (const listener of [...this.listeners]) listener();
			}
			dispose() {
				this.unsubscribe();
				this.listeners.clear();
			}
		};
		/**
		 * The page behind every card: one form per namespace, one save for all of
		 * them, and one snapshot the page renders.
		 */
		var XikeSettingsController = class {
			cards;
			forms = new Map();
			unsubscribes = [];
			listeners = new Set();
			saving = false;
			saved = false;
			failures = [];
			constructor(configForms, cards) {
				this.cards = cards;
				for (const card of cards) {
					if (this.forms.has(card.ns)) continue;
					const specs = cards.filter((item) => item.ns === card.ns).flatMap((item) => item.fields);
					const form = new NamespaceForm(card.ns, configForms.get(card.ns), specs);
					this.unsubscribes.push(form.subscribe(() => {
						this.publish();
					}));
					this.forms.set(card.ns, form);
				}
			}
			/** Publish a projection of the page, rebuilt whenever a form or a draft changes. */
			bind(project) {
				const store = { snapshot: project(), listeners: new Set() };
				store.getSnapshot = () => store.snapshot;
				store.subscribe = (listener) => {
					store.listeners.add(listener);
					return () => {
						store.listeners.delete(listener);
					};
				};
				store.update = (next) => {
					store.snapshot = next;
					for (const listener of [...store.listeners]) listener();
				};
				this.listeners.add(() => {
					store.update(project());
				});
				return store;
			}
			/** Read the page-level state: which cards are served, and what a save would do. */
			snapshot() {
				const cards = [];
				for (const card of this.cards) {
					const form = this.forms.get(card.ns);
					if (!form.ready()) continue;
					const fields = form.views(card.fields);
					if (fields.length === 0) continue;
					cards.push({
						id: card.id,
						title: card.title,
						subtitle: card.subtitle,
						ns: card.ns,
						fields
					});
				}
				const forms = [...this.forms.values()];
				return {
					available: cards.length > 0,
					writable: forms.some((form) => form.writable()),
					dirty: forms.some((form) => form.dirty()),
					invalid: forms.some((form) => form.hasInvalid()),
					saving: this.saving || forms.some((form) => form.saving),
					failed: this.failures.length > 0,
					saved: this.saved,
					failures: this.failures,
					cards
				};
			}
			/** Build the edit, reset, save, and discard actions bound to this page. */
			actions() {
				return {
					edit: (ns, key, text) => {
						const form = this.forms.get(ns);
						if (form === void 0) return;
						this.saved = false;
						this.failures = [];
						form.edit(key, text);
					},
					resetField: (ns, key) => {
						const form = this.forms.get(ns);
						if (form === void 0) return;
						this.saved = false;
						this.failures = [];
						form.reset(key);
					},
					save: () => {
						this.save();
					},
					discard: () => {
						if (this.failures.length === 0 && !this.saved && ![...this.forms.values()].some((form) => form.staged.size > 0)) return;
						for (const form of this.forms.values()) form.discard();
						this.failures = [];
						this.saved = false;
						this.publish();
					}
				};
			}
			/** Build the face the page's slot registration injects. */
			inject(store) {
				return {
					hooks: { xikeSettings: store },
					...this.actions()
				};
			}
			/**
			 * Save every namespace with a staged edit, one `mutate` each, so a
			 * namespace the Host rejects does not discard what the others accepted.
			 */
			async save() {
				if (this.saving) return;
				const dirtyForms = [...this.forms.values()].filter((form) => form.dirty());
				if (!dirtyForms.length) return;
				if (dirtyForms.some((form) => form.hasInvalid())) return;
				this.saving = true;
				this.saved = false;
				this.failures = [];
				this.publish();
				const failures = [];
				try {
					for (const form of dirtyForms) {
						let result;
						try {
							result = await form.save();
						} catch (error) {
							result = {
								ok: false,
								message: error?.message === void 0 ? String(error) : String(error.message)
							};
						}
						if (!result.ok) failures.push({
							ns: form.ns,
							blockKey: NS_LABELS[form.ns] ?? form.ns,
							reasonKey: result.reasonKey,
							message: result.message
						});
					}
				} finally {
					this.saving = false;
					this.failures = failures;
					this.saved = failures.length === 0;
					this.publish();
				}
			}
			publish() {
				for (const listener of [...this.listeners]) listener();
			}
			/** Release every form's accepted-value subscription. */
			dispose() {
				for (const unsubscribe of this.unsubscribes) unsubscribe();
				this.unsubscribes = [];
				for (const form of this.forms.values()) form.dispose();
				this.listeners.clear();
			}
		};
		//#endregion
		//#region page
		/** One style tag for this page; built once even if the plugin remounts. */
		const PAGE_CSS = `
.xike-page {
  display: flex;
  flex-direction: column;
  gap: 12px;
  max-width: 720px;
  color: var(--dsw-alias-label-primary);
}
.xike-title {
  margin: 0;
  font-size: 16px;
  font-weight: 500;
  line-height: 24px;
}
.xike-subtitle {
  margin: 0;
  font-size: 14px;
  line-height: 22px;
  color: var(--dsw-alias-label-tertiary);
}
.xike-card {
  border: 0.5px solid var(--dsw-alias-settings-card-stroke);
  background: var(--dsw-alias-settings-card-fill);
  border-radius: var(--dsw-radius-xl);
  padding: 2px 16px 6px;
}
.xike-card + .xike-card {
  margin-top: 12px;
}
.xike-cardTitle {
  margin: 12px 0 2px;
  font-size: 13px;
  font-weight: 600;
  line-height: 20px;
  color: var(--dsw-alias-label-secondary);
}
.xike-cardSubtitle {
  margin: 0 0 4px;
  font-size: 12px;
  line-height: 1.5;
  color: var(--dsw-alias-label-tertiary);
}
.xike-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 12px 0;
  border-bottom: 0.5px solid var(--dsw-alias-border-l2);
}
.xike-textarea {
  width: 100%;
  box-sizing: border-box;
  min-height: 96px;
  resize: vertical;
  font: inherit;
  line-height: 1.6;
  padding: 8px 10px;
  border-radius: 8px;
  border: 1px solid var(--dsw-alias-border-secondary, rgba(127, 127, 127, 0.28));
  background: var(--dsw-alias-bg-elevated, transparent);
  color: var(--dsw-alias-label-primary, inherit);
}
.xike-textarea:disabled {
  opacity: 0.6;
}
.xike-fieldHead {
  display: flex;
  align-items: center;
  gap: 8px;
}
.xike-label {
  flex: 1;
  min-width: 0;
  font-size: 13px;
  font-weight: 500;
  line-height: 1.5;
  color: var(--dsw-alias-label-primary);
}
.xike-badges {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}
.xike-tag {
  font-size: 11px;
  line-height: 16px;
  color: var(--dsw-alias-label-tertiary);
}
.xike-reset {
  border: none;
  background: none;
  padding: 0;
  font: inherit;
  font-size: 12px;
  line-height: 1.5;
  color: var(--dsw-alias-label-secondary);
  cursor: pointer;
}
.xike-reset:hover:not(:disabled) {
  color: var(--dsw-alias-label-primary);
}
.xike-reset:disabled {
  cursor: default;
}
.xike-hint {
  margin: 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--dsw-alias-label-tertiary);
}
.xike-switchRow {
  flex-direction: row;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}
.xike-switchText {
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}
.xike-switchText .xike-label {
  flex: none;
}
.xike-page .xike-mode {
  align-self: stretch;
  display: flex;
  width: 100%;
}
.xike-page .xike-mode > button {
  flex: 1 1 0;
  min-width: 0;
  height: auto;
  min-height: 28px;
  padding: 4px 6px;
  white-space: normal;
}
.xike-saved {
  margin: 4px 0 0;
  font-size: 12px;
  line-height: 1.5;
  color: var(--dsw-alias-state-success-primary);
}
`;
		function ensureStyles() {
			if (typeof document === "undefined" || document.head === null) return;
			if (document.querySelector("style[data-xike-settings]") !== null) return;
			const tag = document.createElement("style");
			tag.dataset.xikeSettings = "";
			tag.textContent = PAGE_CSS;
			document.head.appendChild(tag);
		}
		ensureStyles();
		/** One titled card; adding a card is one more entry in the page's children. */
		function SettingsCard(props) {
			const children = Array.isArray(props.children) ? props.children : [props.children];
			return react_jsx_runtime.jsxs("section", {
				className: "xike-card",
				"aria-labelledby": props.id,
				children: [
					react_jsx_runtime.jsx("h3", {
						key: "title",
						id: props.id,
						className: "xike-cardTitle",
						children: props.title
					}),
					props.subtitle === void 0 || props.subtitle === null ? null : react_jsx_runtime.jsx("p", {
						key: "subtitle",
						className: "xike-cardSubtitle",
						children: props.subtitle
					}),
					...children
				]
			});
		}
		/** One switch row: the label and hint beside the control. */
		function SwitchField(props) {
			const { t, field, disabled } = props;
			return react_jsx_runtime.jsxs("div", {
				className: "xike-field xike-switchRow",
				children: [
					react_jsx_runtime.jsxs("div", {
						key: "text",
						className: "xike-switchText",
						children: [
							react_jsx_runtime.jsx("span", {
								key: "label",
								className: "xike-label",
								children: t(field.label)
							}),
							field.hint === void 0 ? null : react_jsx_runtime.jsx("p", {
								key: "hint",
								className: "xike-hint",
								children: t(field.hint)
							})
						]
					}),
					react_jsx_runtime.jsx(_deepseek_ai_dsh_client_ui_primitives.Switch, {
						key: "switch",
						checked: field.checked,
						label: t(field.label),
						disabled,
						onChange: (next) => {
							props.onEdit(next ? "true" : "false");
						}
					})
				]
			});
		}
		/** One segmented row: its choices, its "what changes" line, and a reset when overridden. */
		/** 多行文本：人格补充用；回车保留换行，空=清除。 */
		function TextField(props) {
			const { t, field, disabled } = props;
			const rows = Math.max(3, Math.min(12, Number(field.rows) || 5));
			return react_jsx_runtime.jsxs("div", {
				className: "xike-field",
				children: [
					react_jsx_runtime.jsxs("div", {
						key: "head",
						className: "xike-fieldHead",
						children: [
							react_jsx_runtime.jsx("label", {
								key: "label",
								className: "xike-label",
								htmlFor: props.id,
								children: t(field.label)
							}),
							field.overridden ? react_jsx_runtime.jsxs("span", {
								key: "badges",
								className: "xike-badges",
								children: [react_jsx_runtime.jsx("span", {
									key: "tag",
									className: "xike-tag",
									children: t("overridden")
								}), react_jsx_runtime.jsx("button", {
									key: "reset",
									type: "button",
									className: "xike-reset",
									disabled,
									onClick: props.onReset,
									children: t("reset")
								})]
							}) : null
						]
					}),
					react_jsx_runtime.jsx("textarea", {
						key: "control",
						id: props.id,
						className: "xike-textarea",
						rows,
						value: typeof field.text === "string" ? field.text : "",
						placeholder: field.placeholder === void 0 ? "" : t(field.placeholder),
						disabled,
						onChange: (event) => {
							props.onEdit(event.target.value);
						}
					}),
					field.hint === void 0 ? null : react_jsx_runtime.jsx("p", {
						key: "hint",
						className: "xike-hint",
						children: t(field.hint)
					})
				]
			});
		}
		function SegmentedField(props) {
			const { t, field, disabled } = props;
			const options = field.options ?? [];
			const values = options.map((option) => option.value);
			const current = values.includes(field.text) ? field.text : values[0];
			return react_jsx_runtime.jsxs("div", {
				className: "xike-field",
				children: [
					react_jsx_runtime.jsxs("div", {
						key: "head",
						className: "xike-fieldHead",
						children: [
							react_jsx_runtime.jsx("span", {
								key: "label",
								className: "xike-label",
								children: t(field.label)
							}),
							field.overridden ? react_jsx_runtime.jsxs("span", {
								key: "badges",
								className: "xike-badges",
								children: [react_jsx_runtime.jsx("span", {
									key: "tag",
									className: "xike-tag",
									children: t("overridden")
								}), react_jsx_runtime.jsx("button", {
									key: "reset",
									type: "button",
									className: "xike-reset",
									disabled,
									onClick: props.onReset,
									children: t("reset")
								})]
							}) : null
						]
					}),
					react_jsx_runtime.jsx(_deepseek_ai_dsh_client_ui_primitives.SegmentedControl, {
						key: "control",
						id: props.id,
						value: current,
						options: options.map((option) => ({
							value: option.value,
							label: t(option.label)
						})),
						onChange: props.onEdit,
						label: t(field.label),
						disabled,
						className: "xike-mode"
					}),
					field.hint === void 0 ? null : react_jsx_runtime.jsx("p", {
						key: "hint",
						className: "xike-hint",
						children: t(field.hint)
					})
				]
			});
		}
		/** Render one field of a card through the control its kind asks for. */
		function renderField(card, field, t, disabled, props) {
			const id = `xike-${card.id}-${field.key.split(".").join("-")}`;
			if (field.kind === "switch") return react_jsx_runtime.jsx(SwitchField, {
				key: field.key,
				t,
				field,
				disabled,
				onEdit: (text) => {
					props.edit(card.ns, field.key, text);
				}
			});
			if (field.kind === "text") return react_jsx_runtime.jsx(TextField, {
				key: field.key,
				id,
				t,
				field,
				disabled,
				onEdit: (value) => {
					props.edit(card.ns, field.key, value);
				},
				onReset: () => {
					props.resetField(card.ns, field.key);
				}
			});
			if (field.kind === "segmented") return react_jsx_runtime.jsx(SegmentedField, {
				key: field.key,
				id,
				t,
				field,
				disabled,
				onEdit: (value) => {
					props.edit(card.ns, field.key, value);
				},
				onReset: () => {
					props.resetField(card.ns, field.key);
				}
			});
			return react_jsx_runtime.jsx(_deepseek_ai_dsh_client_ui_primitives.SettingsValueField, {
				key: field.key,
				id,
				label: t(field.label),
				hint: field.hint === void 0 ? void 0 : t(field.hint),
				overriddenLabel: t("overridden"),
				resetLabel: t("reset"),
				invalidLabel: t(field.invalidLabel === void 0 ? "invalidNumber" : field.invalidLabel),
				numeric: true,
				disabled,
				text: field.text,
				overridden: field.overridden,
				invalid: field.invalid,
				onEdit: (text) => {
					props.edit(card.ns, field.key, text);
				},
				onReset: () => {
					props.resetField(card.ns, field.key);
				}
			});
		}
		/**
		 * Render the Xi settings page: a title, a subtitle, and the cards the Host
		 * currently serves. Each card is independent; the save at the bottom
		 * writes every namespace with a staged edit.
		 */
		function XikeSettingsPage(props) {
			const { t } = props;
			const state = props.useXikeSettings((snapshot) => snapshot);
			if (props.view === "summary") return t("summary");
			const disabled = !state.writable || state.saving;
			const failedText = state.failures.length === 0 ? t("saveFailed") : state.failures.map((failure) => t("blockSaveFailed", {
				block: t(failure.blockKey),
				reason: failure.reasonKey === void 0 ? failure.message : t(failure.reasonKey)
			})).join("；");
			return react_jsx_runtime.jsxs("div", {
				className: "xike-page",
				children: [
					react_jsx_runtime.jsx("h2", {
						key: "title",
						className: "xike-title",
						children: t("title")
					}),
					react_jsx_runtime.jsx("p", {
						key: "subtitle",
						className: "xike-subtitle",
						children: t("subtitle")
					}),
					react_jsx_runtime.jsxs(_deepseek_ai_dsh_client_ui_primitives.SettingsForm, {
						key: "form",
						labels: {
							...formLabels(t),
							saveFailed: failedText
						},
						state,
						onSave: props.save,
						onDiscard: props.discard,
						children: [
							...state.cards.map((card) => react_jsx_runtime.jsx(SettingsCard, {
							id: `xike-card-${card.id}`,
							key: card.id,
							title: t(card.title),
							subtitle: card.subtitle === void 0 ? void 0 : t(card.subtitle),
							children: card.fields.map((field) => renderField(card, field, t, disabled, props))
						})), state.saved ? react_jsx_runtime.jsx("p", {
							key: "saved",
							className: "xike-saved",
							role: "status",
							"aria-live": "polite",
							children: t("savedHint")
						}) : null]
					})
				]
			});
		}
		//#endregion
		//#region plugin
		/** Dictionary namespace owned by this plugin. */
		const NS = "settings.channelBridge";
		/** Required services (cordis fiber inject). */
		const inject = ["slots", "locale", "configForms"];
		/**
		 * Mount the Xi settings page while the Host serves any of the namespaces
		 * the cards edit, so a deployment that exposes none of these settings
		 * shows no trace of the page. Cards whose namespace is not served (or
		 * whose fields the served value does not carry) are left out.
		 */
		function apply(ctx) {
			const t = ctx.locale.bind(NS);
			ctx.effect(() => ctx.locale.register(NS, {
				zh,
				en
			}), "ui-settings-channel-bridge: dictionaries");
			const controller = new XikeSettingsController(ctx.configForms, CARDS);
			const store = controller.bind(() => controller.snapshot());
			ctx.effect(() => () => {
				controller.dispose();
			}, "ui-settings-channel-bridge: form subscription");
			const namespaces = [...new Set(CARDS.map((card) => card.ns))];
			ctx.effect(() => ctx.configForms.whileServed(namespaces, () => ctx.slots.inject("settings.section", () => ctx.slots.register({
				name: "settings.section",
				id: "xike",
				order: 16,
				label: () => t("nav"),
				locale: NS,
				inject: () => controller.inject(store)
			}, XikeSettingsPage))), "ui-settings-channel-bridge: page");
		}
		//#endregion
		exports.NS = NS;
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
