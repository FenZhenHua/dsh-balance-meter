window.__ModuleLoader__.load({
	id: "@fenzhenhua123/dsh-balance-meter",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		var React = require("react");
		var ReactDOM = require("react-dom");
		var primitives = require("@deepseek-ai/dsh-client-ui-primitives");
		var useAnchoredPosition = primitives.useAnchoredPosition;
		var useDismissOnOutsidePointer = primitives.useDismissOnOutsidePointer;

		var NS = "balance-meter";
		var zh = {
			"balance": "余额",
			"session": "本次",
			"recharge": "充值",
			"bonus": "赠金",
			"tokens": "Tokens",
			"miss": "输入未缓存",
			"hit": "缓存读",
			"write": "缓存写",
			"output": "输出",
			"peak": "高峰",
			"offPeak": "空闲",
			"pricingOfficial": "官方价",
			"pricingEmbedded": "内置价",
			"about": "按 DeepSeek 官方计费（分模型·缓存命中/未命中·峰谷时段）估算",
			"loading": "余额加载中…",
			"signedOut": "未登录"
		};
		var en = {
			"balance": "Balance",
			"session": "This session",
			"recharge": "Topped up",
			"bonus": "Granted",
			"tokens": "tokens",
			"miss": "Input (miss)",
			"hit": "Cache read",
			"write": "Cache write",
			"output": "Output",
			"peak": "Peak",
			"offPeak": "Off-peak",
			"pricingOfficial": "Official",
			"pricingEmbedded": "Embedded",
			"about": "Estimated per DeepSeek official billing (model · cache hit/miss · peak/off-peak)",
			"loading": "Loading balance…",
			"signedOut": "Signed out"
		};

		/** 费用刷新间隔（毫秒）。 */
		var REFRESH_MS = 10000;

		/* --------------------------------------------------------------- *
		 * 工具函数
		 * --------------------------------------------------------------- */
		function formatTokens(n) {
			if (!isFinite(n)) n = 0;
			if (n < 1000) return String(Math.round(n));
			if (n < 1000000) return (n / 1000).toFixed(1).replace(/\.0$/, "") + "K";
			return (n / 1000000).toFixed(2).replace(/\.?0+$/, "") + "M";
		}

		function formatMoney(amount, symbol) {
			var value = Number(amount);
			if (!isFinite(value)) value = 0;
			if (value >= 1 || value === 0) return symbol + value.toFixed(2);
			return symbol + value.toFixed(4);
		}

		/** 汇总钱包数组 → { CNY, USD }。 */
		function sumWallets(wallets) {
			var byCurrency = {};
			(wallets || []).forEach(function (w) {
				var value = Number(w.balance);
				if (!isFinite(value)) value = 0;
				byCurrency[w.currency] = (byCurrency[w.currency] || 0) + value;
			});
			return byCurrency;
		}

		function symbolFor(currency) {
			return currency === "USD" ? "$" : "¥";
		}

		function primaryBalanceText(sum) {
			var keys = Object.keys(sum);
			if (keys.length === 0) return null;
			var currency = sum.CNY !== undefined ? "CNY" : keys[0];
			return formatMoney(sum[currency], symbolFor(currency));
		}

		/* --------------------------------------------------------------- *
		 * 样式：胶囊与「Token 用量」同字号，点击弹层
		 * --------------------------------------------------------------- */
		var CSS = [
			".bm_anchor{box-sizing:border-box;min-width:0;max-width:100%;font-size:calc(var(--dsh-content-font-size-secondary,13px) - 1px);line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px));display:inline-flex}",
			".bm_pill{box-sizing:border-box;max-width:100%;color:var(--dsw-alias-label-tertiary);font:inherit;font-variant-numeric:tabular-nums;line-height:inherit;white-space:nowrap;background:0 0;border:none;border-radius:999px;align-items:center;gap:6px;padding:1px 8px;display:inline-flex;cursor:pointer}",
			".bm_pill svg{flex:none;width:14px;height:14px}",
			"button.bm_pill:hover,button.bm_pill[aria-expanded=true]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}",
			".bm_label{text-overflow:ellipsis;min-width:0;overflow:hidden}",
			".bm_sep{color:var(--dsw-alias-separator-primary);margin:0 6px}",
			".bm_panel{position:fixed;z-index:100;background:var(--dsw-specific-menu);color:var(--dsw-alias-label-primary);border-radius:var(--dsw-radius-md);box-shadow:var(--dsw-elevation-panel);padding:8px 10px;font-size:12px;line-height:18px;white-space:nowrap;max-width:min(420px,calc(100vw - 24px))}",
			".bm_row{display:flex;gap:12px;justify-content:space-between;white-space:nowrap}",
			".bm_row b{font-weight:500;color:var(--dsw-alias-label-secondary)}",
			".bm_note{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;margin-top:4px;white-space:nowrap}"
		].join("\n");
		var CSS_TAG = "dsh-balance-meter/balance-meter.css";
		if (typeof document !== "undefined" && document.querySelector('style[data-plugin-css="' + CSS_TAG + '"]') === null) {
			var styleTag = document.createElement("style");
			styleTag.dataset.plugin = "dsh-balance-meter";
			styleTag.dataset.pluginCss = CSS_TAG;
			styleTag.textContent = CSS;
			document.head.appendChild(styleTag);
		}

		/* --------------------------------------------------------------- *
		 * 组件
		 * --------------------------------------------------------------- */
		function CoinIcon() {
			return React.createElement("svg", {
				viewBox: "0 0 16 16", width: "14", height: "14", "aria-hidden": true
			},
				React.createElement("circle", { cx: "8", cy: "8", r: "6.25", fill: "none", stroke: "currentColor", strokeWidth: "1.4" }),
				React.createElement("path", {
					d: "M8 4.6v6.8M5.6 6.1h3.1a1.5 1.5 0 0 1 0 3H5.6",
					fill: "none", stroke: "currentColor", strokeWidth: "1.4", strokeLinecap: "round", strokeLinejoin: "round"
				})
			);
		}

		var BalanceMeter = React.memo(function BalanceMeter(props) {
			var sessionId = props.sessionId;
			var readBalance = props.readBalance;
			var t = props.t;

			var balanceState = React.useState(null); // { recharge, bonus } | null
			var setBalance = balanceState[1];
			var balance = balanceState[0];
			var failedState = React.useState(false);
			var setFailed = failedState[1];
			var failed = failedState[0];

			var costState = React.useState(null); // { costCny, tokens, byModel, byPeriod, pricing } | null
			var setCost = costState[1];
			var cost = costState[0];

			// 点击弹层状态
			var openState = React.useState(false);
			var open = openState[0];
			var setOpen = openState[1];
			var anchorRef = React.useRef(null);
			var panelRef = React.useRef(null);
			var position = useAnchoredPosition({ open: open, anchorRef: anchorRef, panelRef: panelRef, side: "top", gap: 8, margin: 12 });
			useDismissOnOutsidePointer(anchorRef, open, setOpen, panelRef);

			React.useEffect(function () {
				if (!open) return undefined;
				function onKey(e) {
					if (e.key === "Escape") setOpen(false);
				}
				document.addEventListener("keydown", onKey);
				return function () { document.removeEventListener("keydown", onKey); };
			}, [open]);

			React.useEffect(function () {
				var alive = true;
				function loadBalance() {
					readBalance().then(function (value) {
						if (!alive) return;
						if (value && value.status === "ready") {
							setBalance({ recharge: sumWallets(value.value), bonus: sumWallets(value.bonusWallets) });
							setFailed(false);
						} else {
							setBalance(null);
							setFailed(value !== null && value.status === "failed");
						}
					}).catch(function () {
						if (!alive) return;
						setBalance(null);
						setFailed(true);
					});
				}
				loadBalance();
				var balanceTimer = setInterval(loadBalance, 60000);
				return function () { alive = false; clearInterval(balanceTimer); };
			}, [readBalance]);

			React.useEffect(function () {
				if (sessionId === undefined || sessionId === null) return undefined;
				var alive = true;
				function loadCost() {
					var route = "api/balance-meter/cost?sessionId=" + encodeURIComponent(String(sessionId));
					fetch(route, { headers: { accept: "application/json" } })
						.then(function (res) { return res.json(); })
						.then(function (data) {
							if (!alive) return;
							if (data && data.ok) setCost(data);
							else setCost(null);
						})
						.catch(function () { if (alive) setCost(null); });
				}
				loadCost();
				var timer = setInterval(loadCost, REFRESH_MS);
				return function () { alive = false; clearInterval(timer); };
			}, [sessionId]);

			var hasBalance = balance ? Object.keys(balance.recharge).length > 0 : false;
			var hasCost = cost !== null && cost.costCny !== undefined && cost.costCny >= 0;
			var costCny = hasCost ? cost.costCny : null;

			if (!hasBalance && !hasCost && !failed) return null;

			var pieces = [];
			if (hasBalance) {
				pieces.push(t("balance") + " " + primaryBalanceText(balance.recharge));
			} else if (failed) {
				pieces.push(t("balance") + " " + t("signedOut"));
			}
			if (costCny !== null) {
				pieces.push(t("session") + " ≈" + formatMoney(costCny, "¥"));
			}

			var panelRows = [];
			if (balance) {
				Object.keys(balance.recharge).forEach(function (currency) {
					panelRows.push(React.createElement("div", { className: "bm_row", key: "r-" + currency },
						React.createElement("span", null, t("recharge") + " (" + currency + ")"),
						React.createElement("b", null, formatMoney(balance.recharge[currency], symbolFor(currency)))
					));
				});
				Object.keys(balance.bonus).forEach(function (currency) {
					if (balance.bonus[currency] > 0) {
						panelRows.push(React.createElement("div", { className: "bm_row", key: "b-" + currency },
							React.createElement("span", null, t("bonus") + " (" + currency + ")"),
							React.createElement("b", null, formatMoney(balance.bonus[currency], symbolFor(currency)))
						));
					}
				});
			}
			if (hasCost && cost.tokens) {
				var tk = cost.tokens;
				panelRows.push(React.createElement("div", { className: "bm_row", key: "tokens" },
					React.createElement("span", null, t("tokens")),
					React.createElement("b", null, formatTokens(tk.total))
				));
				panelRows.push(React.createElement("div", { className: "bm_row", key: "miss" },
					React.createElement("span", null, t("miss")),
					React.createElement("b", null, formatTokens(tk.miss))
				));
				panelRows.push(React.createElement("div", { className: "bm_row", key: "hit" },
					React.createElement("span", null, t("hit")),
					React.createElement("b", null, formatTokens(tk.hit))
				));
				panelRows.push(React.createElement("div", { className: "bm_row", key: "write" },
					React.createElement("span", null, t("write")),
					React.createElement("b", null, formatTokens(tk.write))
				));
				panelRows.push(React.createElement("div", { className: "bm_row", key: "output" },
					React.createElement("span", null, t("output")),
					React.createElement("b", null, formatTokens(tk.output))
				));
				if (cost.byPeriod && (cost.byPeriod.peak > 0 || cost.byPeriod.offPeak > 0)) {
					panelRows.push(React.createElement("div", { className: "bm_row", key: "period" },
						React.createElement("span", null, t("peak") + " / " + t("offPeak")),
						React.createElement("b", null,
							"¥" + (cost.byPeriod.peak || 0).toFixed(4) + " / ¥" + (cost.byPeriod.offPeak || 0).toFixed(4))
					));
				}
			}
			var pricingLabel = cost && cost.pricing && cost.pricing.source === "official" ? t("pricingOfficial") : t("pricingEmbedded");
			panelRows.push(React.createElement("div", { className: "bm_note", key: "note" },
				t("about") + " · " + pricingLabel
			));

			return React.createElement("span", { className: "bm_anchor", ref: anchorRef },
				React.createElement("button", {
					type: "button",
					className: "bm_pill",
					"aria-haspopup": "dialog",
					"aria-expanded": open,
					"aria-label": pieces.join(" "),
					onClick: function () { setOpen(!open); },
					children: [
						React.createElement(CoinIcon, null),
						React.createElement("span", { className: "bm_label" },
							pieces.map(function (piece, i) {
								return React.createElement(React.Fragment, { key: i },
									i > 0 ? React.createElement("span", { className: "bm_sep", "aria-hidden": true }, "·") : null,
									piece
								);
							})
						)
					]
				}),
				open && ReactDOM.createPortal(
					React.createElement("div", {
						className: "bm_panel",
						ref: panelRef,
						role: "dialog",
						"aria-label": t("balance"),
						style: position ?? { visibility: "hidden", left: 0, top: 0 },
						children: panelRows
					}),
					document.body
				)
			);
		});

		/* --------------------------------------------------------------- *
		 * 插件入口
		 * --------------------------------------------------------------- */
		var inject = ["slots", "locale", "remote", "remote.account"];

		function apply(ctx) {
			ctx.effect(function () {
				return ctx.locale.register(NS, { zh: zh, en: en });
			}, "balance-meter: locale dictionaries");

			function clientMetadata() {
				var active = "zh-CN";
				try { active = ctx.locale.getSnapshot().active; } catch (_e) {}
				return {
					version: "1.0.0",
					locale: active,
					timezoneOffsetSeconds: -(new Date().getTimezoneOffset()) * 60
				};
			}

			ctx.slots.inject("conversation.composer.dock", function () {
				return ctx.slots.register({
					name: "conversation.composer.dock",
					id: "balance-meter",
					order: 20,
					locale: NS,
					inject: function () {
						return {
							readBalance: function () {
								return ctx.remote.account.getBalance(clientMetadata()).then(function (result) {
									if (!result || !result.ok) return null;
									return result.value;
								});
							}
						};
					}
				}, BalanceMeter);
			});
		}

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
