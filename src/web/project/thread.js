import { BRAND_TITLES,brandMark,hasBrand,labelOf } from '../agents.js';
import { settleApprovalCards } from '../approvals.js';
import { api,checkBuild } from '../connection.js';
import { addLogRecord } from '../console.js';
import { esc,hue,money } from '../format.js';
import { notifyNeedsInput,toast } from '../notifications.js';
import { maybeReloadPreview,onServerFrame,onSpecFrame } from '../preview.js';
import { state } from '../state.js';
import { drawStatusbar } from '../statusbar.js';
import { onTeamFrame } from '../team.js';
import { lineFor } from '../transcript.js';

/** thread behavior for one mounted project.
 * view contains live accessors to the owning project view's state and callbacks.
 * Creating this module only binds functions; startup and cleanup belong to project.js.
 */
export function createThread(view) {


    // ---- status (title, chips, routebar, rail, statusbar) --------------------
    function drawChips(){
      var p = state.project; if (!p) return;
      var chips = document.getElementById("chips");
      if (!chips) return;
      var adapters = p.agents.filter(function(a){ return a.tier === "adapter"; });
      if (state.selected === null) state.selected = p.holder || (adapters[0] && adapters[0].id) || null;
      chips.innerHTML = adapters.map(function(a){
        var sel = a.id === state.selected;
        return '<button class="chip' + (sel ? " sel" : "") + '" data-id="' + esc(a.id) + '">' +
          brandMark(a.kind) + esc(a.id) + ' <span class="role">' + esc(a.role) + (a.id === p.holder ? " \u2190" : "") + "</span>" +
          (a.busy ? ' <span class="busy"></span>' : "") + "</button>";
      }).join("");
      Array.prototype.forEach.call(chips.querySelectorAll(".chip"), function(chip){
        chip.onclick = function(){ state.selected = chip.getAttribute("data-id"); drawStatus(); };
      });
    }

    function drawStatus(){
      var p = state.project; if (!p) return;
      var adapters = p.agents.filter(function(a){ return a.tier === "adapter"; });
      if (state.selected === null) state.selected = p.holder || (adapters[0] && adapters[0].id) || null;
      var nm = document.getElementById("pname"); if (nm) nm.textContent = p.name;
      var stat = document.getElementById("pstat");
      if (stat) stat.textContent = p.needsInput ? "needs input" : p.costUsd > 0 ? money(p.costUsd) : "";

      // Send ⇄ stop. While an adapter is mid-turn the composer offers the
      // interrupt, in the one place you're already looking. Driven by the
      // agents' own busy flag rather than a local guess, so a turn you started
      // from your phone shows a stop here too.
      var anyBusy = adapters.some(function(a){ return a.busy; });
      var sendBtn = document.getElementById("send");
      var stopBtn = document.getElementById("stop");
      // Orchestrate has its own send, and a run is stopped from its view
      // (Abort), not by interrupting whichever agent the composer points at.
      var orchMode = state.cmode === "orch";
      if (sendBtn && stopBtn) {
        sendBtn.style.display = orchMode || anyBusy ? "none" : "";
        stopBtn.style.display = !orchMode && anyBusy ? "" : "none";
      }

      var hint = document.getElementById("hint");
      var orun = view.orchRunForChat();
      if (hint) hint.textContent = orchMode
        ? (view.planState
          ? "plan mode \u00b7 orchestrator writes PLAN.md + a spec per task that any agent can pick up"
          : "the orchestrator plans your goal into tasks \u00b7 each worker gets its own thread and git worktree")
        : orun && !view.orchTerminal(orun.status)
        ? "this is an orchestra thread \u00b7 what you send goes to its orchestrator"
        : orun && orun.status !== "aborted" && orun.status !== "moved"
        ? "this orchestra has finished \u00b7 sending reopens it with its orchestrator"
        : view.planState
        ? "plan mode \u00b7 agent writes a plan to plans/\u2026, no code changes"
        : state.selected && state.selected !== p.holder
        ? "send will shift the baton to " + labelOf(state.selected)
        : (view.desktop ? "click the agent to switch \u00b7 baton: " : "tap a chip to shift agents \u00b7 baton: ") + (p.holder || "\u2014");
      view.drawOrchTabDot(p.orchestra);
      view.updateModelLabel(); // the picker button reflects whoever's selected now
      if (!view.desktop) drawChips();
      // Whose thread is this? A task's worker, or a pinned thread's agent —
      // null when the thread has no opinion and the baton should answer.
      function threadAgent(p){
        // currentChat() belongs to the shell's scope; this render is in
        // another. state.currentChat is the seam between them — calling the
        // bare name threw, and a throw in here hid the header entirely.
        var chat = state.currentChat ? state.currentChat() : null;
        if (!chat || chat === "main") return null;
        var agents = (p && p.agents) || [];
        // A task's agent field is a roster agent id OR a kind, so match either —
        // an id that isn't in the roster would resolve to nothing and the
        // header would fall back to the baton, which is the bug being fixed.
        var resolve = function(want){
          if (!want) return null;
          for (var k = 0; k < agents.length; k++) if (agents[k].id === want) return agents[k].id;
          for (var m = 0; m < agents.length; m++) if (agents[m].kind === want) return agents[m].id;
          return null;
        };
        var run = p && p.orchestra;
        var tasks = (run && run.threads) || [];
        for (var i = 0; i < tasks.length; i++) {
          if (tasks[i] && tasks[i].chat === chat) return resolve(tasks[i].agent);
        }
        var chats = (p && p.chats) || [];
        for (var j = 0; j < chats.length; j++) {
          if (chats[j].id === chat && chats[j].agentId) return resolve(chats[j].agentId);
        }
        return null;
      }

      // agent header block — who the composer talks to, and where
      var ah = document.getElementById("agenthead");
      if (ah) {
        // Resolve over EVERY agent, bridges included — selecting Kiro or
        // Antigravity must show Kiro or Antigravity, not fall through to the
        // first adapter (which read as "the header says Claude").
        //
        // The thread you are IN wins over the baton. An orchestra task thread
        // belongs to the agent doing that task: during a run with four
        // workers, every task thread used to claim to be whoever held the
        // project baton, so you could not tell a Codex task from an
        // Antigravity one by looking at it. A thread pinned to an agent (its
        // own binding) answers the same way, for the same reason.
        var wanted = threadAgent(p) || state.selected || p.holder;
        var focus = null;
        (p.agents || []).forEach(function(a){ if (a.id === wanted) focus = a; });
        if (!focus) focus = adapters[0] || (p.agents || [])[0] || null;
        if (focus) {
          var hh = hue(focus.id);
          ah.innerHTML =
            // the agent's own logo when we have it; the hue monogram is only
            // for kinds with no mark (a custom adapter, echo)
            (hasBrand(focus.kind)
              ? '<span class="ag brandbox" title="' + esc(BRAND_TITLES[focus.kind]) + '">' + brandMark(focus.kind, "brand xl") + "</span>"
              : '<span class="ag" style="background:color-mix(in srgb, hsl(' + hh + ',60%,50%) 18%, transparent);color:hsl(' + hh + ',60%,var(--agent-l))">' + esc(focus.id.slice(0, 2)) + "</span>") +
            '<span class="meta"><span class="l1">' + esc(focus.id) +
            '<span class="role">' + esc(focus.role) + (focus.id === p.holder ? " \u00b7 baton" : "") + (focus.busy ? " \u00b7 working\u2026" : "") + "</span></span>" +
            '<span class="l2">' + esc(p.dir || p.name) + "</span></span>" +
            '<span class="badge kind">' + esc(focus.kind || "agent") + "</span>";
          ah.style.display = "";
        } else {
          ah.style.display = "none";
        }
      }
      var bar = document.getElementById("routebar");
      var r = p.route;
      if (bar) {
        if (r && (r.status === "running" || r.status === "waiting_human")) {
          var pos = r.mode === "dynamic"
            ? "hop " + (r.current + 1) + (r.maxHops ? " of \u2264" + r.maxHops : "")
            : "step " + (r.current + 1) + "/" + r.steps.length;
          bar.innerHTML = '<div class="routebar"><button class="abort btn xs outline" id="rabort">abort</button>\u25b8 ' +
            esc(r.name || "route") + " " + pos + " &middot; " + esc(r.steps[r.current]) +
            (r.mode === "dynamic" && r.reason ? '<span style="opacity:.7"> &mdash; ' + esc(r.reason) + "</span>" : "") +
            (r.status === "waiting_human" ? '<div class="q">\u23f8 ' + esc(r.pendingQuestion || "waiting for you") + " \u2014 reply below to resume</div>" : "") + "</div>";
          var ab = document.getElementById("rabort");
          if (ab) ab.onclick = function(){
            api("/api/projects/" + view.pid + "/route", { method: "DELETE" })
              .then(function(){ toast("route aborted"); refresh(); })
              .catch(function(err){ toast(err.message); });
          };
        } else { bar.innerHTML = ""; }
      }
      // only the live views (Source Control, Tasks) redraw on status polls;
      // Explorer/Search are user-driven so they aren't torn down mid-scroll.
      if (view.desktop) {
        if (state.railView === "scm" || state.railView === "tasks") view.drawRail();
        drawStatusbar();
      }
    }


    function refresh(){
      // Returned, so a caller that changed the roster can wait for the answer
      // before redrawing off it.
      return api("/api/projects/" + view.pid).then(function(j){
        state.project = j.project;
        drawStatus();
      }).catch(function(err){ toast(err.message); });
    }


    // ---- feed + live websocket ----------------------------------------------
    function append(events){
      var feed = document.getElementById("feed"); if (!feed) return;
      // only the loading placeholder gets cleared — never real history
      if (feed.firstChild && feed.firstChild.className === "loader") feed.innerHTML = "";
      var html = "", added = false;
      events.forEach(function(e){
        if (e.id <= state.lastId) return;
        state.lastId = e.id;
        if (e.kind === "needs_input" && e.payload) state.lastQuestion = e.payload.question || null;
        // An answered approval folds the card it answers. Only when that card
        // is out of the loaded window does it need a line of its own — and
        // the card may be in the html not yet inserted, so flush first.
        if (e.kind === "approval" && e.payload && e.payload.phase === "decided") {
          if (html) { feed.insertAdjacentHTML("beforeend", html); html = ""; added = true; }
          if (settleApprovalCards(e.payload.approvalId, e.payload.behavior, e.payload.message)) return;
        }
        html += lineFor(e);
      });
      if (html || added) { if (html) feed.insertAdjacentHTML("beforeend", html);
        var sc = feed.parentNode;
        if (sc && sc.scrollHeight) sc.scrollTop = sc.scrollHeight;
        else window.scrollTo(0, document.body.scrollHeight); }
    }

    function flushPending(){
      view.historyLoaded = true;
      if (view.pendingWs.length) { append(view.pendingWs); view.pendingWs = []; }
    }

    // Reading the thread again from scratch. Changing the transcript level
    // changes what every past line renders as, so there is nothing to patch —
    // the whole feed is re-read rather than re-styled.
    function loadHistory(){
      var feed = document.getElementById("feed");
      if (feed) feed.innerHTML = '<div class="loader"></div>';
      state.lastId = 0;
      return api("/api/projects/" + view.pid + "/events?limit=60&chat=" + encodeURIComponent(view.chatId))
        .then(function(j){ append(j.events || []); flushPending(); })
        .catch(function(err){ toast(err.message); flushPending(); });
    }


    function connect(){
      var proto = location.protocol === "https:" ? "wss://" : "ws://";
      // Carry the bearer token in the subprotocol, not the URL — a query token
      // lands in browser history and proxy logs; a header does not.
      var ws = new WebSocket(proto + location.host + "/ws?project=" + encodeURIComponent(view.pid), ["loom.bearer." + state.token]);
      state.ws = ws;
      ws.onopen = function(){
        state.wsLive = true; drawStatusbar();
        // (re)read what's waiting: anything filed while the socket was down
        // arrived as events nobody heard
        view.loadApprovals();
        // Open shells only once the socket is truly listening, or the pty's
        // first output (its prompt) is broadcast into the void. Runs once —
        // a reconnect must not spawn another set of terminals.
        var start = state.startTerminals;
        if (start) { state.startTerminals = null; start(); }
      };
      ws.onmessage = function(ev){
        try {
          var frame = JSON.parse(ev.data);
          if (frame.type === "hello") { checkBuild(); return; }
          if (frame.type === "term") { view.onTermFrame(frame); return; }
          if (frame.type === "spec" || frame.type === "spec_done") { onSpecFrame(frame); return; }
          // A log record belongs to no chat — a daemon fault has no
          // conversation, and it's the one you most need to see.
          if (frame.type === "log" && frame.record) { addLogRecord(frame.record); return; }
          // Loom Teams: a teammate's presence or a feed event. Daemon-level, so
          // it arrives on whichever project socket is open; re-read the view.
          if (frame.type === "team") { onTeamFrame(frame); return; }
          // the prompt queue changed — sent, edited, reordered, paused
          if (frame.type === "queue") { view.onQueueFrame(frame); return; }
          // a dev server started, stopped, crashed, or printed a line
          if (frame.type === "server") { onServerFrame(frame); return; }
          // an agent changed files while a preview is open: show the new page
          if (frame.type === "event" && frame.event && frame.event.kind === "turn_diff") maybeReloadPreview();
          if (frame.type === "event" && frame.event) {
            // "an agent needs you" is the whole reason Loom exists, so it must
            // reach you even when this isn't the chat you're looking at, or the
            // tab is in the background: announce it, flash the title, and (if
            // permitted) raise an OS notification. Deliberately above the
            // per-chat filter below, which would otherwise swallow it.
            if (frame.event.kind === "needs_input") notifyNeedsInput(frame.event);
            // An orchestra spans many chats — its run's and one per task — so
            // the view listens above the per-chat filter too.
            view.onOrchEvent(frame.event);
            // Approvals are per project, not per chat: the badge counts them
            // all, and a request from another thread still reaches you.
            view.onApprovalEvent(frame.event);
            view.onFleetEvent(frame.event);
            // one socket carries the whole project; this thread is one chat.
            // An event with no chat predates chats and belongs to main.
            if ((frame.event.chat || "main") !== view.chatId) return;
            if (view.historyLoaded) append([frame.event]);
            else view.pendingWs.push(frame.event);
          }
        } catch (e) {}
      };
      ws.onclose = function(){
        state.wsLive = false; drawStatusbar();
        if (state.pid === view.pid) state.timers.push(setTimeout(connect, 3000));
      };
    }
return { drawStatus, refresh, loadHistory, connect };
}
