/** Browser transcript module. See README.md for ownership and startup. */
import { agentGlyph,agentLabel,brandMark,kindOf,labelOf } from './agents.js';
import { approvalCard } from './approvals.js';
import { esc,hue,mdToHtml,money } from './format.js';
import { ICONS } from './icons.js';
import { toast } from './notifications.js';
import { state } from './state.js';
import { orchGoalName } from './team.js';


  // ---- event rendering -----------------------------------------------------
  function lineFor(e){
    var p = e.payload || {};
    if (e.kind === "message") {
      if (!e.agentId) {
        // Loom briefing an orchestrator is a page of instructions, not a line:
        // fold it, headed by its first line, so the plan it produced stays in view.
        if (p.author === "loom" && p.orchestra) {
          return '<details class="orchbrief"><summary>\u25b8 Loom \u2192 orchestrator: ' + esc(String(p.text || "").split("\n")[0].slice(0, 120)) + "</summary>" +
            '<div class="md">' + mdToHtml(p.text) + "</div></details>";
        }
        if (p.author === "loom") return '<div class="sys">\u25b8 ' + esc(String(p.text).split("\n")[0]) + "</div>";
        // The orchestrator's brief to a worker opens every task thread. It is
        // not yours, so it must not wear your bubble.
        if (p.author === "orchestrator") {
          return '<div class="msg agent"><div class="who" style="color:var(--thread-ink)"><span class="orchmark">' + ICONS.orchestra + "</span>orchestrator" +
            (p.orchestra && p.orchestra.taskId ? '<span class="thinktag">' + esc(p.orchestra.taskId) + "</span>" : "") + "</div>" +
            '<div class="bubble md" style="border-left-color:var(--thread)">' + mdToHtml(p.text) +
            (tview() === "verbose" ? rawBlock(p) : "") + "</div></div>";
        }
        // Your own messages: markdown too, so a pasted snippet or list reads right.
        return '<div class="msg user"><div class="bubble md">' + mdToHtml(p.text) + "</div></div>";
      }
      var h = hue(e.agentId);
      // Reasoning / thinking (codex, grok, and now claude) renders as a distinct
      // collapsible block above the reply — dimmed, folded by default, so it's
      // there when you want it and out of the way when you don't.
      if (p.reasoning) {
        // At Normal the reasoning isn't the transcript — it's the working out.
        // Thinking folds it in; Verbose opens it.
        var tv = tview();
        if (tv === "normal") return "";
        return '<div class="msg agent thinking"><div class="who" style="color:hsl(' + h + ',60%,var(--agent-l))">' +
          brandMark(kindOf(e.agentId)) + esc(e.agentId) + '<span class="thinktag">thinking</span></div>' +
          '<details class="thinkbox"' + (tv === "verbose" ? " open" : "") + '><summary>reasoning</summary><div class="md">' +
          mdToHtml(p.text) + "</div></details></div>";
      }
      return '<div class="msg agent"><div class="who" style="color:hsl(' + h + ',60%,var(--agent-l))">' +
        brandMark(kindOf(e.agentId)) + esc(e.agentId) +
        '</div><div class="bubble md" style="border-left-color:hsl(' + h + ',50%,var(--selvage-l))">' + mdToHtml(p.text) + "</div></div>";
    }
    if (e.kind === "tool_call") {
      return '<div class="tool">\u2699 ' + esc(p.summary || p.tool || p.name) +
        (tview() === "verbose" ? rawBlock(p) : "") + "</div>";
    }
    if (e.kind === "file_edit") return '<div class="tool">\u270e ' + esc(p.path) + "</div>";
    if (e.kind === "turn_diff") {
      var fl = (p.files || []).map(function(f){ return f.path; });
      var enc = p.patch ? encodeURIComponent(String(p.patch)) : "";
      var lbl = "Update(" + fl.length + " file" + (fl.length === 1 ? "" : "s") + ")";
      return '<div class="turncard" data-patch="' + enc + '" data-label="' + esc(lbl) + '">' +
        '<div class="tch"><span>\u270e ' + lbl + "</span>" +
        '<span class="tca">+' + Number(p.added || 0) + '</span><span class="tcd">\u2212' + Number(p.removed || 0) + "</span>" +
        (p.checkpoint ? '<button class="tcrw" type="button" data-rewind="' + esc(p.checkpoint) +
            '" title="put these files back the way they were before this turn">' + ICONS.rewind + "Rewind</button>" : "") +
        '<span class="tchev">\u25b8</span></div>' +
        '<div class="tcf">' + esc(fl.slice(0, 4).join(", ")) + (fl.length > 4 ? " \u2026" : "") + "</div>" +
        '<div class="tcdiff" style="display:none"></div></div>';
    }
    if (e.kind === "checkpoint") {
      if (p.reason !== "rewound") return tview() === "verbose" ? '<div class="sys" style="opacity:.6">\u21ba checkpoint \u00b7 ' + esc(p.label || p.id) + "</div>" : "";
      return '<div class="sys ok">\u21ba Rewound to \u201c' + esc(String(p.label || p.id).slice(0, 80)) + '\u201d \u00b7 ' +
        Number(p.files || 0) + " file" + (Number(p.files || 0) === 1 ? "" : "s") +
        (p.undo ? ' <button class="btn xs outline" type="button" data-rewind="' + esc(p.undo) + '">Undo the rewind</button>' : "") + "</div>";
    }
    if (e.kind === "handoff") return '<div class="handoff"><span class="a">' + esc(p.from || "\u2014") + '</span><span class="shuttle">\u27ff</span><span class="b">' + esc(p.to || "\u2014") + "</span></div>";
    // Sub-agents: indent under the turn, marked as borrowed hands — the parent
    // kept the baton, and the thread should read that way.
    if (e.kind === "subtask_started") return '<div class="sys" style="padding-left:22px">\u21b3 ' + esc(e.agentId) + " picks up a subtask for " + esc(p.parent) + ": " + esc(String(p.task || "").slice(0, 90)) + "</div>";
    if (e.kind === "subtask_done") return '<div class="sys" style="padding-left:22px;color:var(--live)">\u21b3 ' + esc(e.agentId) + " finished its subtask</div>";
    if (e.kind === "subtask_failed") return '<div class="sys err" style="padding-left:22px">\u21b3 ' + esc(e.agentId) + " subtask failed: " + esc(String(p.message || "").slice(0, 90)) + "</div>";
    if (e.kind === "suggestion") return '<div class="sys warn">\u2726 ' + esc(p.reason || "handoff suggested") + "</div>";
    if (e.kind === "needs_input") {
      // The one moment Loom exists to surface — an agent blocked on a human —
      // used to be a line of text with nothing to click. Worse in an orchestra
      // thread, where the composer aims at the orchestrator, so typing the
      // answer sent it to the wrong agent entirely (#106).
      var q = String(p.question || "what next?");
      var who = String(e.agentId || "agent");
      var opts = questionChoices(q);
      return '<div class="nicard" data-niask="' + esc(who) + '" data-nichat="' + esc(e.chat || "") + '">' +
        '<div class="nih">' + brandMark(kindOf(who)) + '<span class="niwho">' + esc(who) + "</span>" +
        '<span class="nitag">needs you</span></div>' +
        '<div class="niq">' + esc(q) + "</div>" +
        (opts.length ? '<div class="niopts">' + opts.map(function(o){
          return '<button class="nio" type="button" data-nipick="' + esc(o) + '">' + esc(o) + "</button>";
        }).join("") + "</div>" : "") +
        '<div class="nirow"><input class="nitext" placeholder="answer ' + esc(who) + '…" spellcheck="false">' +
        '<button class="btn primary xs nisend" type="button">Send</button></div>' +
        '<div class="nidone"></div></div>';
    }
    if (e.kind === "decision") return '<div class="sys">\u2605 ' + esc(p.text) + "</div>";
    if (e.kind === "memory_import") return '<div class="sys" style="color:var(--thread-ink)">\u25c8 imported ' + esc(p.file) + " into the shared brain</div>";
    if (e.kind === "error") return '<div class="sys err">\u2717 ' + esc(p.message) + "</div>";
    if (e.kind === "route_started") {
      if (p.mode === "dynamic") return '<div class="sys">\u25b8 route "auto" started \u2014 ' + esc(p.router) + " picks each hop</div>";
      return '<div class="sys">\u25b8 route started: ' + esc((p.steps || []).join(" \u2192 ")) + "</div>";
    }
    if (e.kind === "route_step") {
      var pos = p.of ? "step " + (Number(p.step) + 1) + "/" + Number(p.of) : "hop " + (Number(p.step) + 1);
      if (p.skipped) {
        return '<div class="sys" style="opacity:.65">\u2937 ' + pos + " \u2192 " + esc(p.agent) +
          " " + esc(p.reason || "skipped") + "</div>";
      }
      return '<div class="sys">\u25b8 ' + pos + " \u2192 " + esc(p.agent) +
        (p.reason ? ' <span style="opacity:.7">(' + esc(p.reason) + ")</span>" : "") + "</div>";
    }
    if (e.kind === "route_paused") return '<div class="sys warn">\u23f8 route paused \u2014 ' + esc(p.agent) + " asks: " + esc(p.question) + "</div>";
    if (e.kind === "route_resumed") return '<div class="sys">\u25b8 route resumed</div>';
    if (e.kind === "route_completed") return '<div class="sys ok">\u2713 route completed</div>';
    if (e.kind === "route_failed") return '<div class="sys ' + (p.aborted ? "warn" : "err") + '">\u2298 ' + esc(p.reason || "route ended") + "</div>";
    if (e.kind === "run_complete") return '<div class="tool">\u2713 ' + esc(e.agentId) + " done</div>";
    if (e.kind === "orchestra") return orchLine(p);
    // An agent in "always ask" waiting on you: a card with the two answers.
    // Its answer arrives as a second event, which folds the card (append()),
    // so this line only shows when the card itself is out of the window.
    if (e.kind === "approval") {
      if (p.phase === "requested") return approvalCard({ approvalId: p.approvalId, agent: e.agentId, tool: p.tool, input: p.input, ts: e.ts });
      if (p.phase === "decided") return '<div class="sys apl">' + (p.behavior === "allow" ? '<span class="ok">\u2713 allowed</span> ' : '<span class="no">\u2715 denied</span> ') +
        esc(p.tool || "tool") + " for " + esc(labelOf(e.agentId)) + (p.message ? " \u2014 " + esc(p.message) : "") + "</div>";
    }
    return "";
  }


  /**
   * One orchestra step as a thread line. Every phase gets words; an unknown
   * one still reads as a sentence, never as the payload it came in.
   */
  var ORCH_TASK_ST = { pending: ["pending", "off"], running: ["running", "live"], done: ["done", "ok"],
    conflict: ["conflict", "warn"], needs_input: ["needs input", "warn"], failed: ["failed", "err"], cancelled: ["cancelled", "off"] };

  var ORCH_RUN_ST = { starting: ["starting", "live"], planning: ["planning", "live"], running: ["running", "live"],
    reviewing: ["reviewing", "live"], waiting_human: ["needs you", "warn"], completed: ["completed", "ok"],
    failed: ["failed", "err"], aborted: ["aborted", "off"], moved: ["moved", "off"] };

  // Loom Teams, Phase 4: a goal PR's way to main (LandingState.state, D52\u2013D63)
  var LAND_ST = { open: ["PR open", "off"], pending: ["checks running", "live"], green: ["green", "ok"], failing: ["failing", "err"],
    fixing: ["fixing", "live"], needs_human: ["needs you", "warn"], queued: ["queued", "off"], landing: ["landing", "live"], merged: ["merged", "ok"], closed: ["closed", "off"] };

  function landPill(l){
    var s = LAND_ST[l && l.state] || [(l && l.state) || "\u2014", "off"];
    return '<span class="opill ' + s[1] + '" data-lstate="' + esc(l && l.state) + '"><span class="odot ' + s[1] + '"></span>' + esc(s[0]) + "</span>";
  }

  function orchLine(p){
    var ph = p.phase;
    var tone = { ok: " ok", warn: " warn", err: " err" };
    function row(cls, html){ return '<div class="sys orch' + (cls || "") + '">' + html + "</div>"; }
    function names(list){ return (list || []).map(function(id){ return esc(labelOf(id)); }).join(", "); }
    if (ph === "started") {
      var o = p.orchestrator || {};
      return row("", "\ud83c\udfbc Orchestra started \u2014 " + esc(agentLabel(o.kind, o.agent)) + " is orchestrating " +
        (names(p.workers) || "its workers") + (p.maxParallel ? " (" + Number(p.maxParallel) + " in parallel)" : "")) +
        (p.note ? row(" warn", "\u26a0 " + esc(p.note)) : "");
    }
    if (ph === "plan") {
      var acts = {};
      (p.actions || []).forEach(function(a){ acts[a] = (acts[a] || 0) + 1; });
      var said = [];
      if (acts.spawn) said.push(acts.spawn + " new task" + (acts.spawn === 1 ? "" : "s"));
      if (acts.send) said.push(acts.send + " follow-up" + (acts.send === 1 ? "" : "s"));
      if (acts.cancel) said.push(acts.cancel + " cancelled");
      if (acts.ask) said.push("a question for you");
      if (acts.done) said.push("done");
      return row("", "Round " + Number(p.round || 1) + ": orchestrator planned \u2014 " + (said.join(", ") || "no changes")) +
        (p.rejected && p.rejected.length ? row(" warn", "\u26a0 not applied: " + esc(p.rejected.join("; ").slice(0, 240))) : "");
    }
    if (ph === "task" && p.task) {
      var t = p.task, st = ORCH_TASK_ST[t.status] || [t.status || "", "off"];
      // Each task runs in its own thread. The row that announces it is the
      // way in — otherwise the orchestrator names threads you can only find
      // by hunting the sidebar for a title you half remember (#100).
      var inner = esc(t.id) + " \u00b7 " + esc(String(t.title || "").slice(0, 80)) + " \u2192 " +
        agentGlyph(t.kind, t.agent) + esc(agentLabel(t.kind, t.agent)) + " \u00b7 " + esc(st[0]);
      return row(tone[st[1]] || "", t.chat
        ? '<button class="tlink" type="button" data-gochat="' + esc(t.chat) + '" title="open ' + esc(t.id) + '\u2019s thread">' +
            inner + '<span class="tlinkgo">' + ICONS.thread + "</span></button>"
        : inner);
    }
    if (ph === "task_started") return row("", "\u25b8 " + esc(p.taskId) + " started \u2014 " + esc(String(p.title || "").slice(0, 90)) + (p.agent ? " \u00b7 " + esc(labelOf(p.agent)) : ""));
    if (ph === "task_finished") {
      var fs = ORCH_TASK_ST[p.status] || [p.status || "finished", "off"], nf = (p.files || []).length;
      return row(tone[fs[1]] || "", (fs[1] === "ok" ? "\u2713 " : "\u25a0 ") + esc(p.taskId) + " finished \u00b7 " + esc(fs[0]) +
        (nf ? " \u00b7 " + nf + " file" + (nf === 1 ? "" : "s") + " changed" : ""));
    }
    if (ph === "reviewing") return row("", "Round " + Number(p.round || 1) + ": orchestrator reviewing results");
    if (ph === "waiting") return row(" warn", "\u23f8 Orchestrator asks: " + esc(p.question || "what next?"));
    if (ph === "completed") {
      var n = (p.tasks || []).length;
      return row(" ok", "\u2713 Orchestra complete" + (p.summary ? " \u2014 " + esc(String(p.summary).slice(0, 200)) : "") +
        " \u00b7 " + n + " task" + (n === 1 ? "" : "s") + " \u00b7 " + money(p.costUsd) +
        (p.branch ? " \u00b7 branch " + esc(p.branch) : "") +
        (p.runId ? ' <button class="btn xs outline" type="button" data-orch-apply="' + esc(p.runId) + '">Apply</button>' : ""));
    }
    if (ph === "failed") return row(" err", "\u2717 Orchestra failed \u2014 " + esc(p.error || "stopped") +
      (p.runId ? ' <button class="btn xs outline" type="button" data-orch-apply="' + esc(p.runId) + '">Apply what finished</button>' : ""));
    if (ph === "aborted") return row(" warn", "\u2298 Orchestra aborted" + (p.reason ? " \u2014 " + esc(p.reason) : ""));
    if (ph === "applied") return row(" ok", "\u2713 Orchestra merged into " + esc(p.into || "your branch"));
    if (ph === "cleaned") return row("", "Orchestra worktrees cleaned up");
    // Plan mode: the orchestrator's plan, on the run's branch, as files.
    if (ph === "plan_written") {
      var specs = Math.max(0, Number(p.files || 0) - 1);
      return row(" ok", "\u270e " + (p.final ? "Plan updated with the results" : "Plan written") + " \u2014 " + esc(p.dir || "plans") + "/PLAN.md" +
        (specs ? " + " + specs + " task spec" + (specs === 1 ? "" : "s") : ""));
    }
    if (ph === "plan_failed") return row(" err", "\u2717 Couldn\u2019t write the plan \u2014 " + esc(p.error || "unknown error"));
    // Git delivery: what the project's policy did with the finished run.
    if (ph === "delivered") {
      if (p.mode === "pr") {
        var num = String(p.prUrl || "").match(/\/pull\/(\d+)/);
        return row(" ok", /^https?:\/\//.test(String(p.prUrl || ""))
          ? "\u2713 Opened " + '<a href="' + esc(p.prUrl) + '" target="_blank" rel="noopener noreferrer">' + (num ? "PR #" + esc(num[1]) : "a PR") + " \u2197</a>" + (p.pushed ? " from " + esc(p.pushed) : "")
          : "\u2713 Pushed " + esc(p.pushed || "the run\u2019s branch"));
      }
      return row(" ok", "\u2713 Merged into " + esc(p.into || "your branch") + (p.mode === "push" ? " and pushed" : ""));
    }
    // Loom Teams, Phase 2: what the team made a task wait for, and what it changed.
    if (ph === "task_held") {
      var hd = p.hold || {}, tid = esc(p.taskId || "a task");
      if (hd.kind === "wait") return row(" live", "\u23f8 " + tid + " waits for " + orchGoalName(hd.runId) + "\u2019s PR to merge before it starts");
      if (hd.kind === "zone") return row(" warn", "\u23f8 " + tid + " is queued behind " + esc(hd.holder || "a teammate") + "\u2019s hard zone <code>" + esc(hd.zone || "") + "</code>");
      if (hd.kind === "capacity") return row("", "\u23f8 " + tid + " is queued \u2014 " + esc(String(hd.reason || "the team is at its agent limit").slice(0, 200)));
      return row(" warn", "\u23f8 " + tid + " needs the orchestrator \u2014 " + esc(String(hd.reason || "a teammate overlaps it").slice(0, 240)));
    }
    // Phase 4: the PR's own state lives on the run card (every poll emits
    // one); an alert is the sentence worth keeping in the thread.
    if (ph === "landing") return "";
    if (ph === "alert") return row(" warn", "\u26a0 " + esc(String(p.text || "").slice(0, 240)));
    // Phase 5: the goal moving to a runner and back (D75, D76)
    if (ph === "moving") return row(" live", "\u21e2 Moving to " + esc(p.to || "a runner") + " \u2014 running turns finish first (up to 2 min)");
    if (ph === "moved") return row("", "\u21e2 Moved to " + esc(p.to || "a runner") + " \u2014 it carries on there; this copy is read-only");
    if (ph === "imported") return row(" ok", "\u21e0 Picked up from " + esc(p.from || "another machine") + (p.tasks ? " \u00b7 " + Number(p.tasks) + " task" + (p.tasks === 1 ? "" : "s") : ""));
    if (ph === "synced") return row("","\u21bb Brought the goal up to date with " + esc(p.with || "main") + " before a waiting task started");
    if (ph === "delivery_policy") return row(" warn", "\u26a0 " + esc(p.branch || "the base branch") + " is protected by team policy \u2014 delivering as a PR instead of " +
      (p.from === "push" ? "merging and pushing" : "merging"));
    if (ph === "delivery_failed") return row(" err", "\u2717 Delivery (" + esc(p.mode || "git") + ") failed \u2014 " + esc(String(p.error || "").slice(0, 200)) +
      (p.runId ? ' <button class="btn xs outline" type="button" data-orch-deliver="' + esc(p.runId) + '">Retry delivery</button>' : ""));
    return row("", "\ud83c\udfbc Orchestra \u00b7 " + esc(String(ph || "update").replace(/_/g, " ")));
  }


  /**
   * How much of a turn the thread shows.
   *
   *   normal   — what an agent said and did: prose, edits, one line per tool
   *   thinking — plus the reasoning it streamed, which Loom already receives
   *   verbose  — plus the raw material: the full payload behind each tool
   *              call, and nothing folded
   *
   * Per project, because "show me everything" is a thing you want while
   * reading one project's run and not while reading another's.
   */
  var TVIEWS = ["normal", "thinking", "verbose"];

  function tview(){
    try {
      var v = localStorage.getItem("loomTView:" + state.pid);
      return TVIEWS.indexOf(v) >= 0 ? v : "normal";
    } catch (e) { return "normal"; }
  }

  function setTView(v){
    if (TVIEWS.indexOf(v) < 0) return;
    try { localStorage.setItem("loomTView:" + state.pid, v); } catch (e) {}
    if (state.redrawFeed) state.redrawFeed();
    toast("transcript: " + v);
  }


  /**
   * The options an agent's question offers, when it plainly offers some.
   *
   * "Want me to dig into the DBC integration, or get the tree committable?"
   * is two choices and should be two buttons. This only fires when the split
   * is unambiguous — a question mark, an "or" joining clauses of a sensible
   * length — because a wrong guess puts words in your mouth and sends them to
   * an agent. When unsure it returns nothing and you get the text box, which
   * is never wrong.
   */
  function questionChoices(q){
    var text = String(q || "").trim();
    // The last SENTENCE, not the last question — splitting only on "?" left
    // "I found three failing tests." glued to the front of the first option.
    var ask = text.split(/(?<=[.?!])\s+/).filter(Boolean).pop() || text;
    if (ask.indexOf("?") < 0) return [];
    var parts = ask.replace(/\?+\s*$/, "").split(/,\s+or\s+|\s+or\s+/i);
    if (parts.length < 2 || parts.length > 3) return [];
    var out = [];
    for (var i = 0; i < parts.length; i++) {
      var c = parts[i]
        .replace(/^(?:so\s+)?(?:do you want me to|would you like me to|want me to|should i|shall i|do you want|i can)\s+/i, "")
        .replace(/^[\s,;:\-\u2014]+|[\s,;:.]+$/g, "")
        .trim();
      // "npm" is a real answer; two characters is where it stops being one.
      if (c.length < 2 || c.length > 70) return [];
      // The agent's own casing. Capitalising turned "npm" into "Npm".
      out.push(c);
    }
    return out;
  }


  /** Raw payload, for verbose — the thing the summary was made from. */
  function rawBlock(payload){
    var text = "";
    try { text = JSON.stringify(payload, null, 2); } catch (e) { text = String(payload); }
    if (!text || text === "{}") return "";
    return '<details class="rawbox"><summary>raw</summary><div class="mdcodewrap">' +
      '<button class="mdcopy" type="button" title="copy">' + ICONS.copy + '</button>' +
      '<pre class="mdcode"><code>' + esc(text) + "</code></pre></div></details>";
  }
export { LAND_ST,landPill,lineFor,ORCH_RUN_ST,ORCH_TASK_ST,orchLine,questionChoices,rawBlock,setTView,tview,TVIEWS };
