// @dsh-balance-meter — Host half（精确计费）。
//
// 在宿主机侧逐请求重放会话日志，按 DeepSeek 官方计费方式计算“本次使用金额”：
//   - 分模型：deepseek-v4-pro / deepseek-flash（未知模型回退到 v4-pro，避免低估）
//   - 分缓存：输入缓存命中（便宜）/ 缓存未命中 + 缓存写入（全价）/ 输出
//   - 分时段：北京时间峰谷时段（高峰 = 空闲 × 2，工作日 9-12、14-18 为高峰）
// 价格每 6 小时从官方价格页自动刷新，失败则回退到内置价格表。

const name = "balance-meter";
const inject = ["connection", "sessionQuery"];

/** 费用路由（浏览器半侧 fetch 调用）。 */
const COST_ROUTE = "/api/balance-meter/cost";
/** 官方价格页（中文）。 */
const PRICING_URL = "https://api-docs.deepseek.com/zh-cn/quick_start/pricing/";
/** 价格刷新间隔。 */
const REFRESH_MS = 6 * 60 * 60 * 1000;
/** 高峰时段价格 = 空闲时段 × 2（官方规则：空闲为高峰的一半）。 */
const PEAK_MULTIPLIER = 2;
/** 未知模型回退目标。 */
const FALLBACK_MODEL = "deepseek-v4-pro";

/**
 * 内置价格表（人民币 / 百万 tokens，空闲时段）。
 * 高峰时段 = 表中数值 × PEAK_MULTIPLIER。
 */
const EMBEDDED_PRICING = {
	"deepseek-v4-pro": { miss: 4.5, hit: 0.15, output: 13.5 },
	"deepseek-flash": { miss: 1.0, hit: 0.02, output: 4.0 }
};

/**
 * 2026 年中国法定节假日（仅列出落在工作日的日期；周末已由 isPeak 的周末判断覆盖）。
 * 这些日期全天按空闲时段计费。
 * 来源：国办发明电〔2025〕7 号《关于 2026 年部分节假日安排的通知》。
 */
const CN_WEEKDAY_HOLIDAYS_2026 = new Set([
	"01-01", "01-02",                                                       // 元旦
	"02-16", "02-17", "02-18", "02-19", "02-20", "02-23",                  // 春节
	"04-06",                                                               // 清明节
	"05-01", "05-04", "05-05",                                            // 劳动节
	"06-19",                                                               // 端午节
	"09-25",                                                               // 中秋节
	"10-01", "10-02", "10-05", "10-06", "10-07"                            // 国庆节
]);

/** 判断某个北京时间（已偏移到 UTC+8 的 Date）是否为 2026 年落在工作日的法定节假日。 */
function isWeekdayHoliday(bj) {
	if (bj.getUTCFullYear() !== 2026) return false;
	const mm = String(bj.getUTCMonth() + 1).padStart(2, "0");
	const dd = String(bj.getUTCDate()).padStart(2, "0");
	return CN_WEEKDAY_HOLIDAYS_2026.has(mm + "-" + dd);
}

/**
 * 判断北京时间是否处于高峰时段。
 * 高峰：周一至周五（不含中国法定节假日）9:00-12:00、14:00-18:00。
 * 空闲：其余时段，包括周末（含调休上班的周末）与中国法定节假日全天。
 * @param timeMs - Unix 毫秒时间戳。
 */
function isPeak(timeMs) {
	const bj = new Date(Number(timeMs) + 8 * 3600 * 1000);
	const day = bj.getUTCDay();
	if (day === 0 || day === 6) return false; // 周末（含调休上班的周末）→ 空闲
	if (isWeekdayHoliday(bj)) return false; // 法定节假日（工作日）→ 全天空闲
	const t = bj.getUTCHours() + bj.getUTCMinutes() / 60;
	return (t >= 9 && t < 12) || (t >= 14 && t < 18);
}

/** 归一化模型名到价格表键。 */
function normalizeModel(model) {
	if (typeof model !== "string" || model === "") return FALLBACK_MODEL;
	const m = model.toLowerCase();
	if (m === "deepseek-v4-pro" || m.startsWith("deepseek-v4-pro")) return "deepseek-v4-pro";
	if (m === "deepseek-flash" || m.startsWith("deepseek-v4-flash")) return "deepseek-flash";
	// 旧模型名 / 未知模型 → 回退到 v4-pro（宁可高估，不低估）。
	return FALLBACK_MODEL;
}

/** 取某个模型在指定时段的三档单价。 */
function priceFor(model, pricing, peak) {
	const key = normalizeModel(model);
	const base = pricing[key] ?? pricing[FALLBACK_MODEL] ?? EMBEDDED_PRICING[FALLBACK_MODEL];
	const mult = peak ? PEAK_MULTIPLIER : 1;
	return {
		miss: base.miss * mult,
		hit: base.hit * mult,
		output: base.output * mult
	};
}

/** 从一个 assistant 事件取 provider 上报的 usage（兼容 final 与 streaming 两种形态）。 */
function usageOf(event) {
	if (event.type === "assistant/message" && event.data && event.data.usage !== undefined) return event.data.usage;
	if (event.type !== "assistant/message" && event.type !== "assistant/attempt") return undefined;
	const stream = event.data && event.data.stream;
	if (Array.isArray(stream)) {
		for (let i = stream.length - 1; i >= 0; i--) {
			const rec = stream[i];
			if (rec && rec.type === "chunk" && rec.chunk && rec.chunk.type === "usage") return rec.chunk.usage;
		}
	}
	return undefined;
}

/**
 * 重放会话事件，按官方计费方式累计费用。
 * 复刻 token-meter 的“同 (turn, step) 替换”语义，保证流式尝试与最终消息不重复计费。
 * @returns { costCny, tokens, byModel, byPeriod }
 */
function computeSessionCost(events, pricing) {
	const totals = { miss: 0, hit: 0, write: 0, output: 0, tokens: 0, cost: 0 };
	const byModel = new Map();
	const byPeriod = { offPeak: 0, peak: 0 };
	let last = null;
	let currentModel = FALLBACK_MODEL;

	const applySample = (sample, sign) => {
		totals.miss += sign * sample.miss;
		totals.hit += sign * sample.hit;
		totals.write += sign * sample.write;
		totals.output += sign * sample.output;
		totals.tokens += sign * sample.tokens;
		totals.cost += sign * sample.cost;
		const m = byModel.get(sample.model) ?? { cost: 0, tokens: 0 };
		m.cost += sign * sample.cost;
		m.tokens += sign * sample.tokens;
		byModel.set(sample.model, m);
		byPeriod[sample.peak ? "peak" : "offPeak"] += sign * sample.cost;
	};

	for (const event of events) {
		if (event.type === "request/header") {
			currentModel = (event.data && event.data.header && event.data.header.config && event.data.header.config.model) || currentModel;
			continue;
		}
		if (event.type === "request/context") {
			currentModel = (event.data && event.data.model) || currentModel;
			continue;
		}
		if (event.type === "llm/retry-started") {
			last = null;
			continue;
		}
		if (event.type !== "assistant/message" && event.type !== "assistant/attempt") continue;
		const usage = usageOf(event);
		if (usage === undefined) continue;

		const turn = event.data.turn;
		const step = event.data.step;
		const model = (event.type === "assistant/message" && event.data.message && event.data.message.source && event.data.message.source.model) || currentModel;
		const peak = isPeak(event.time);
		const miss = (usage.inputTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
		const hit = usage.cacheReadTokens ?? 0;
		const write = usage.cacheWriteTokens ?? 0;
		const output = usage.outputTokens ?? 0;
		const tokens = miss + hit + output;
		const p = priceFor(model, pricing, peak);
		const cost = (miss * p.miss + hit * p.hit + output * p.output) / 1e6;

		const sample = { turn, step, miss, hit, write, output, tokens, cost, model: normalizeModel(model), peak };
		if (last !== null && last.turn === turn && last.step === step) applySample(last, -1);
		applySample(sample, 1);
		last = sample;
	}

	return {
		costCny: totals.cost,
		tokens: {
			miss: totals.miss,
			hit: totals.hit,
			write: totals.write,
			output: totals.output,
			total: totals.tokens
		},
		byModel: Object.fromEntries(byModel),
		byPeriod
	};
}

/**
 * 从官方价格页 HTML 解析空闲时段单价。
 * @returns { [model]: { miss, hit, output } } 或 null。
 */
function parsePricing(html) {
	if (typeof html !== "string" || html.indexOf("价格") < 0) return null;
	const models = [];
	const modelRegex = /<td>((deepseek-[a-z0-9-]+))(?:<sup>.*?<\/sup>)?<\/td>/g;
	let m;
	while ((m = modelRegex.exec(html)) !== null) {
		if (!models.includes(m[1])) models.push(m[1]);
	}
	if (models.length < 1) return null;

	const offPeak = [];
	const priceSection = html.slice(html.indexOf("价格"));
	const rowRegex = /空闲时段<\/td>\s*<td>([\d.]+)元<\/td>\s*<td>([\d.]+)元<\/td>/g;
	let r;
	while ((r = rowRegex.exec(priceSection)) !== null) {
		offPeak.push([parseFloat(r[1]), parseFloat(r[2])]);
	}
	if (offPeak.length < 3) return null;

	const result = {};
	for (let i = 0; i < models.length; i++) {
		result[models[i]] = {
			hit: offPeak[0][i],
			miss: offPeak[1][i],
			output: offPeak[2][i]
		};
	}
	return result;
}

function json(status, body) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" }
	});
}

function apply(ctx) {
	let pricing = { ...EMBEDDED_PRICING };
	let pricingSource = "embedded";
	let pricingAsOf = new Date().toISOString();

	const refresh = async () => {
		try {
			const res = await fetch(PRICING_URL, { signal: AbortSignal.timeout(15000) });
			if (!res.ok) return;
			const html = await res.text();
			const parsed = parsePricing(html);
			if (parsed && Object.keys(parsed).length > 0) {
				pricing = parsed;
				pricingSource = "official";
				pricingAsOf = new Date().toISOString();
			}
		} catch (_) {
			// 网络或解析失败：保留内置价格表。
		}
	};

	ctx.effect(() => {
		refresh();
		const timer = setInterval(refresh, REFRESH_MS);
		return () => clearInterval(timer);
	}, "balance-meter: pricing refresh");

	ctx.effect(() => ctx.connection.fetch.register({
		path: COST_ROUTE,
		methods: ["GET"],
		requestBody: "buffered",
		fetch: async (request) => {
			const url = new URL(request.url);
			const sessionId = url.searchParams.get("sessionId");
			if (!sessionId) return json(400, { ok: false, error: "missing sessionId" });
			const query = ctx.get("sessionQuery");
			if (query === undefined) return json(503, { ok: false, error: "sessionQuery unavailable" });
			try {
				const snapshot = await query.readSession(sessionId);
				const result = computeSessionCost(snapshot.events, pricing);
				return json(200, {
					ok: true,
					costCny: result.costCny,
					tokens: result.tokens,
					byModel: result.byModel,
					byPeriod: result.byPeriod,
					pricing: { source: pricingSource, asOf: pricingAsOf }
				});
			} catch (error) {
				return json(500, { ok: false, error: error instanceof Error ? error.message : String(error) });
			}
		}
	}), "balance-meter: cost route");
}

export { apply, computeSessionCost, inject, isPeak, name, normalizeModel, parsePricing, priceFor };
