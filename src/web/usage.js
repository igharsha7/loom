/**
 * The context meter on a native agent's chip: tokens in context against the
 * model's window, "compacting…" while the harness compacts, and the provider
 * account's usage-limit windows. Seeded from the project status
 * (AgentStatus.context / .limits) and kept live from the thread's events —
 * the same fold the daemon does in runtime/native-usage.ts.
 */
import { esc,tokens } from './format.js';

var CLAUDE_WINDOWS = { five_hour: "5-hour", seven_day: "weekly", seven_day_opus: "weekly Opus",
  seven_day_sonnet: "weekly Sonnet", seven_day_overage_included: "weekly (overage)", overage: "overage" };

/** Fold one event into the project's agent statuses. True when a meter changed. */
function observeUsage(project, e){
  if (!project || !e || !e.agentId) return false;
  var agent = null;
  project.agents.forEach(function(a){ if (a.id === e.agentId) agent = a; });
  if (!agent) return false;
  var p = e.payload || {}, ctx = agent.context || null;
  if (e.kind === "run_complete" || e.kind === "error" || (e.kind === "status" && p.state === "interrupted")) {
    if (!ctx || !ctx.compacting) return false;
    agent.context = Object.assign({}, ctx, { compacting: false });
    return true;
  }
  if (e.kind !== "status") return false;
  if (p.state === "context_usage" && typeof p.usedTokens === "number") {
    agent.context = { usedTokens: p.usedTokens, maxTokens: typeof p.maxTokens === "number" ? p.maxTokens : ctx ? ctx.maxTokens : null,
      compacting: ctx ? ctx.compacting : false, compactedAt: ctx ? ctx.compactedAt : null, at: e.ts };
    return true;
  }
  if (p.state === "compacting") {
    agent.context = Object.assign({ usedTokens: 0, maxTokens: null, compactedAt: null }, ctx || {}, { compacting: true, at: e.ts });
    return true;
  }
  if (p.state === "native_compacted") {
    agent.context = Object.assign({ usedTokens: 0, maxTokens: null }, ctx || {},
      typeof p.postTokens === "number" ? { usedTokens: p.postTokens } : {}, { compacting: false, compactedAt: e.ts, at: e.ts });
    return true;
  }
  if (p.state === "usage_limits" && Array.isArray(p.windows)) {
    // Limits belong to an account. The registry supplies each roster entry's identity.
    var provider = p.provider, account = p.accountKey || (agent.provider && agent.provider.accountKey) || provider;
    if (!provider) return false;
    project.agents.forEach(function(a){
      var owner = a.provider && a.provider.accountKey;
      var driver = agent.provider && agent.provider.driverKind || agent.kind;
      var ownerDriver = a.provider && a.provider.driverKind || a.kind;
      if (ownerDriver !== driver || (owner ? owner !== account : a.id !== agent.id)) return;
      var byId = {}, order = [];
      ((a.limits && a.limits.windows) || []).concat(p.windows).forEach(function(w){
        if (!w || !w.id) return; if (!(w.id in byId)) order.push(w.id); byId[w.id] = w;
      });
      var scope = p.reachedScope || (agent.provider && agent.provider.reachedScope) || (provider === "claude" ? "window" : "account");
      var blocked = scope === "account" ? [] : (a._blockedLimits || (a.limits && a.limits.reached ? [a.limits.reached] : [])).slice();
      if (scope !== "account") p.windows.forEach(function(w){ if (w.id !== p.reached) blocked = blocked.filter(function(id){ return id !== w.id; }); });
      if (p.reached && blocked.indexOf(p.reached) < 0) blocked.push(p.reached);
      a._blockedLimits = blocked;
      a.limits = { provider: provider, windows: order.map(function(id){ return byId[id]; }), reached: blocked[0] || null, at: e.ts };
    });
    return true;
  }
  return false;
}

function windowName(w){
  if (CLAUDE_WINDOWS[w.id]) return CLAUDE_WINDOWS[w.id];
  var m = w.windowMinutes;
  if (m === 10080) return "weekly";
  if (m && m % 60 === 0) return (m / 60) + "-hour";
  if (m) return m + "-minute";
  return w.id;
}

function resets(ms){
  if (!ms) return "";
  var d = new Date(ms), soon = ms - Date.now() < 24 * 3600 * 1000;
  return " (resets " + (soon ? d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : d.toLocaleDateString([], { weekday: "short", hour: "numeric" })) + ")";
}

/** The chip's meter, or "" when the harness hasn't reported anything yet. */
function usageMeter(agent){
  var ctx = agent.context, lim = agent.limits;
  if (!ctx && !(lim && lim.windows && lim.windows.length)) return "";
  var lines = [], pct = null;
  if (ctx && ctx.maxTokens) {
    pct = Math.min(100, Math.round(ctx.usedTokens / ctx.maxTokens * 100));
    lines.push("Context: " + ctx.usedTokens.toLocaleString() + " of " + ctx.maxTokens.toLocaleString() + " tokens (" + pct + "%) — compacts automatically");
  } else if (ctx && ctx.usedTokens) lines.push("Context: " + ctx.usedTokens.toLocaleString() + " tokens");
  var hot = null;
  ((lim && lim.windows) || []).forEach(function(w){
    lines.push("Usage, " + windowName(w) + ": " + Math.round(w.usedPercent) + "%" + resets(w.resetsAt));
    if (w.usedPercent >= 80 && (!hot || w.usedPercent > hot.usedPercent)) hot = w;
  });
  if (lim && lim.reached) lines.push("Limit reached: " + windowName({ id: lim.reached }));
  var title = esc(lines.join("\n"));
  var h = "";
  if (ctx && ctx.compacting) h += '<span class="ctxm live" title="' + title + '">compacting…</span>';
  else if (pct !== null) h += '<span class="ctxm' + (pct >= 85 ? " warn" : "") + '" title="' + title + '"><span class="ctxbar"><i style="width:' + pct + '%"></i></span>' + pct + "%</span>";
  else if (ctx && ctx.usedTokens) h += '<span class="ctxm" title="' + title + '">' + tokens(ctx.usedTokens) + "</span>";
  if (lim && lim.reached) h += '<span class="ctxm err" title="' + title + '">limit</span>';
  else if (hot) h += '<span class="ctxm warn" title="' + title + '">' + esc(windowName(hot)) + " " + Math.round(hot.usedPercent) + "%</span>";
  else if (!h) h += '<span class="ctxm" title="' + title + '">limits</span>';
  return h;
}

export { observeUsage,usageMeter };
