/** Browser shell module. See README.md for ownership and startup. */
import { brandMark } from './agents.js';
import { copyText } from './clipboard.js';
import { api,clearTimers,logout } from './connection.js';
import { esc,highlight,hue,money } from './format.js';
import { ICONS,LOADER } from './icons.js';
import { applyRail,applyWidths,cssPx,makeResizer,railOpen,shellEl,toggleRail } from './layout.js';
import { openMenu } from './menus.js';
import { toast } from './notifications.js';
import { openPalette } from './palette.js';
import { renderProject } from './project.js';
import { openProjectModal,openProjectSettings,openSetupModal } from './settings.js';
import { SETUP_SEEN_KEY,root,state } from './state.js';
import { drawStatusbar,loadGithub,loadLoomPad,loadUpdate } from './statusbar.js';
import { openTaskModal } from './tasks.js';
import { THEME_BTN,bindTheme } from './theme.js';


  // ---- router ----------------------------------------------------------
  var mq = window.matchMedia("(min-width:900px)");

  function isDesktop(){ return mq.matches; }

  function clearShell(){ if (state.shellTimer) { clearInterval(state.shellTimer); state.shellTimer = null; } }


  // Desktop workspace: projects/agents rail + tabbed pane + source-control rail.
  function renderShell(){
    clearTimers();
    clearShell();
    var m = location.hash.match(/^#p\/(.+)$/);
    var cur = m ? m[1] : null;
    // The project the URL asked for, kept separately from the one on screen so
    // a deep link that loses the race with the first /api/projects can still be
    // honoured when it arrives. select() clears it — see refresh().
    var wanted = cur;
    root.innerHTML =
      '<div class="dshell">' +
      '<aside class="sidebar">' +
        '<div class="shead"><span class="wordmark">lo<b>om</b></span></div>' +
        '<div class="topnav"><button class="navitem" id="newtask">' + ICONS.tasks + "New task<span class=\"kbd\">N</span></button>" +
        '<button class="navitem" id="newproj">' + ICONS.folderPlus + "New project<span class=\"kbd\">P</span></button></div>" +
        '<div class="snav">' + ICONS.search + '<input id="sfilter" placeholder="Search" autocomplete="off" spellcheck="false">' +
          '<button class="snkbd" id="palettebtn" type="button" title="Search everything (\u2318K)" aria-label="open command palette">\u2318K</button></div>' +
        '<div class="stitle">projects<button id="addproj" class="iconbtn" title="new project" aria-label="new project">' + ICONS.plus + "</button></div>" +
        '<div class="slist" id="slist">' + LOADER + "</div>" +
        '<div class="sfoot">' +
        '<a class="iconbtn" title="Loom on GitHub" href="https://github.com/nickthelegend/loom" target="_blank" rel="noreferrer">' + ICONS.help + "</a>" +
        '<button id="setupbtn" class="iconbtn" title="Settings" aria-label="settings">' + ICONS.gear + "</button>" +
        '<span class="spacer"></span>' +
        THEME_BTN +
        '<button id="unpair" class="iconbtn" title="unpair this device">' + ICONS.unpair + "</button></div>" +
        '<div class="rz rz-sidebar" id="rz-sidebar" title="drag to resize"></div>' +
      "</aside>" +
      '<section class="dmain" id="dmain"></section>' +
      '<aside class="rail">' +
        '<div class="rz rz-rail" id="rz-rail" title="drag to resize"></div>' +
        '<div class="railbar">' +
          '<button class="iconbtn rvbtn" data-view="explorer" title="Explorer">' + ICONS.files + "</button>" +
          '<button class="iconbtn rvbtn" data-view="search" title="Search">' + ICONS.search + "</button>" +
          '<button class="iconbtn rvbtn" data-view="scm" title="Source Control">' + ICONS.branch + "</button>" +
          '<button class="iconbtn rvbtn" data-view="tasks" title="Agents" aria-label="Agents">' + ICONS.agents + "</button>" +
          '<span class="spacer"></span>' +
          '<button id="railrefresh" class="iconbtn" title="refresh">' + ICONS.refresh + "</button>" +
          // No second panel toggle. #railbtn in the tab strip is the one control
          // and it works both ways; this one wore the same icon a few inches
          // away and could only ever close — two buttons for one job, and you
          // had to learn which was which.
        "</div>" +
        '<div class="rhead" id="railtitle"><span class="b">Explorer</span></div>' +
        '<div class="rbody" id="railbody"><div class="rempty">select a project</div></div></aside>' +
      '<div class="statusbar" id="statusbar"></div>' +
      "</div>";
    document.getElementById("unpair").onclick = logout;
    document.getElementById("setupbtn").onclick = openSetupModal;
    // First run: show it rather than wait to be found. Someone who has just
    // paired has no agents set up and no reason to guess that the small icon in
    // the sidebar foot is where that happens — and Loom with nothing to drive
    // is a window with nothing in it. Once only; the button is always there.
    try {
      if (!localStorage.getItem(SETUP_SEEN_KEY)) {
        localStorage.setItem(SETUP_SEEN_KEY, "1");
        setTimeout(openSetupModal, 400);
      }
    } catch (e) {
      // private mode, no storage — the button still works
    }
    // The toggle lives in the shell's foot now, so bind it here — renderProject
    // also calls bindTheme, but it never runs when no project is selected.
    bindTheme();
    document.getElementById("newtask").onclick = function(){ openTaskModal(cur); };
    if (!state.railView) state.railView = localStorage.getItem("loomRailView") || "explorer";
    applyWidths();
    makeResizer("rz-sidebar", {
      get: function(){ return cssPx(shellEl(), "--sbw", 264); },
      set: function(w){ shellEl().style.setProperty("--sbw", w + "px"); },
      min: 200, max: function(){ return Math.min(520, window.innerWidth - 480); },
      def: 264, key: "loomSbW",
    });
    makeResizer("rz-rail", {
      get: function(){ return cssPx(shellEl(), "--railw", 304); },
      set: function(w){ shellEl().style.setProperty("--railw", w + "px"); },
      min: 220, max: function(){ return Math.min(620, window.innerWidth - 520); },
      def: 304, key: "loomRailW", invert: true,
    });
    Array.prototype.forEach.call(document.querySelectorAll(".railbar .rvbtn"), function(b){
      b.onclick = function(){
        state.railView = b.getAttribute("data-view");
        localStorage.setItem("loomRailView", state.railView);
        if (!railOpen()) toggleRail();
        if (state.drawRail) state.drawRail();
      };
    });
    applyRail();
    var filter = "";
    // The box narrows the project list instantly — that's a local filter over
    // names you already have — and a beat later searches inside the open
    // project's conversations. Two speeds on purpose: the list must not lag
    // your typing, and the search must not fire a request per keystroke.
    var chatTo;
    document.getElementById("sfilter").oninput = function(){
      filter = (this.value || "").trim().toLowerCase();
      drawList();
      clearTimeout(chatTo);
      chatTo = setTimeout(runChatSearch, 260);
    };
    document.getElementById("sfilter").onkeydown = function(e){
      if (e.key === "Escape") {
        this.value = ""; filter = ""; state.chatHits = null; drawList();
      }
    };
    document.getElementById("addproj").onclick = openProjectModal;
    document.getElementById("newproj").onclick = openProjectModal;
    var pbtn = document.getElementById("palettebtn");
    if (pbtn) pbtn.onclick = function(ev){ ev.preventDefault(); openPalette(); };
    state.refreshProjects = refresh;
    document.getElementById("railrefresh").onclick = function(){
      // refresh whichever view is showing: Explorer re-reads the file tree,
      // the others re-read the working tree / project state.
      if (state.refreshExplorer && state.railView === "explorer") { state.refreshExplorer(); return; }
      state.tree = null;
      if (state.drawRail) state.drawRail();
      api("/api/projects/" + (cur || "") + "/tree").then(function(j){
        state.tree = j.tree || {};
        if (state.drawRail) state.drawRail();
      }).catch(function(err){ toast(err.message); });
      refresh();
    };
    var dmain = document.getElementById("dmain");
    function drawEmpty(){
      dmain.innerHTML = '<div class="dempty"><div class="biglogo">loom</div><div class="hair"></div>' +
        "<div>select a project to open its workspace</div></div>";
    }
    /**
     * Search the open project's conversations.
     *
     * Scoped to the open project: that's the thread you remember, and searching
     * every project's log on every keystroke is a different feature with a
     * different cost. Two characters minimum — one letter matches everything
     * and answers nothing.
     */
    function runChatSearch(){
      var q = (filter || "").trim();
      if (!cur || q.length < 2) {
        if (state.chatHits) { state.chatHits = null; drawList(); }
        return;
      }
      api("/api/projects/" + cur + "/chats/search?q=" + encodeURIComponent(q))
        .then(function(j){
          state.chatHits = { q: q, hits: j.hits || [], truncated: !!j.truncated };
          drawList();
        })
        .catch(function(){ /* the list still filters; a failed search shouldn't blank it */ });
    }

    /**
     * Matching messages, appended under whatever the list showed.
     *
     * Both paths call this — the one with projects and the one without —
     * because "no project called that" is usually the start of a search, not
     * the end of one.
     */
    function drawChatHits(el){
      var ch = state.chatHits;
      if (!ch || !ch.q || (filter || "").trim() !== ch.q) return;
      el.innerHTML += '<div class="stitle">in this conversation' +
        (ch.hits.length ? '<span class="cnt">' + ch.hits.length + (ch.truncated ? "+" : "") + "</span>" : "") +
        "</div>";
      el.innerHTML += ch.hits.length
        ? ch.hits.map(function(h){
            var who = h.agentId || "you";
            return '<div class="chit" data-hit-chat="' + esc(h.chat) + '" data-hit-id="' + h.eventId + '"' +
              ' title="open this message in ' + esc(h.chat) + '">' +
              '<span class="cw">' + esc(who) + "</span>" +
              '<span class="cs">' + highlight(h.snippet, ch.q) + "</span></div>";
          }).join("")
        : '<div class="rempty" style="padding:8px 10px">nothing in this project’s messages either</div>';
      Array.prototype.forEach.call(el.querySelectorAll("[data-hit-chat]"), function(row){
        row.onclick = function(){ setChat(cur, row.getAttribute("data-hit-chat")); };
      });
    }

    // Which projects are expanded, remembered across reloads. Absent from the
    // map means "follow selection" — the current project opens on its own, so a
    // fresh user needs no clicks, and only an explicit toggle is persisted.
    function projOpenMap(){
      try { return JSON.parse(localStorage.getItem("loomProjOpen") || "{}"); } catch (e) { return {}; }
    }
    function isProjOpen(id, sel){
      var m = projOpenMap();
      return Object.prototype.hasOwnProperty.call(m, id) ? !!m[id] : !!sel;
    }
    function toggleProj(id, sel){
      var m = projOpenMap();
      var now = Object.prototype.hasOwnProperty.call(m, id) ? !!m[id] : !!sel;
      m[id] = !now;
      localStorage.setItem("loomProjOpen", JSON.stringify(m));
    }

    function drawList(){
      var el = document.getElementById("slist"); if (!el) return;
      if (!state.projects.length) {
        el.innerHTML = '<div class="sys" style="padding:24px 8px;line-height:1.7">no projects yet<br><span style="opacity:.75">run <b class="mono" style="font-weight:500">loom init</b></span></div>';
        return;
      }
      var shown = !filter ? state.projects : state.projects.filter(function(p){
        if (String(p.name || "").toLowerCase().indexOf(filter) >= 0) return true;
        return (p.agents || []).some(function(a){ return String(a.id).toLowerCase().indexOf(filter) >= 0; });
      });
      if (!shown.length) {
        // No project by that name is not the end of the search — it is usually the
        // start of one. The early return here meant the chat hits below never
        // rendered in the exact case you were searching for a message rather than
        // a project, which is the common case.
        el.innerHTML = '<div class="sys" style="padding:16px 8px">no project called “' + esc(filter) + '”</div>';
        drawChatHits(el);
        return;
      }
      el.innerHTML = shown.map(function(p){
        var r = p.route, act = r && (r.status === "running" || r.status === "waiting_human");
        var adapters = (p.agents || []).filter(function(a){ return a.tier === "adapter"; });
        var sel = p.id === cur;
        var open = isProjOpen(p.id, sel);
        var gh = hue(p.id + p.name);
        var rows = '<div class="srow' + (sel ? " sel" : "") + '" data-id="' + esc(p.id) + '">' +
          '<div class="n">' +
          '<button class="scaret' + (open ? " open" : "") + '" data-caret="' + esc(p.id) + '" aria-label="' + (open ? "collapse " : "expand ") + esc(p.name) + '" aria-expanded="' + (open ? "true" : "false") + '">' + ICONS.chevron + "</button>" +
          '<span class="pglyph' + (p.needsInput ? " hot" : "") + '" style="background:color-mix(in srgb, hsl(' + gh + ',60%,50%) 20%, transparent);color:hsl(' + gh + ',60%,var(--agent-l))">' + esc((p.name || "?").slice(0, 1).toUpperCase()) + '</span><span class="nm">' + esc(p.name) + "</span>" +
          // The gear takes the trailing slot, so the count needs its own
          // margin-left:auto — .cnt's rule loses to the badge's inline style.
          (act ? '<span class="badge live" style="margin-left:auto">' + (r.current + 1) + "/" + r.steps.length + "</span>" : '<span class="cnt" style="margin-left:auto">' + adapters.length + "</span>") +
          '<button class="psetbtn" data-pset="' + esc(p.id) + '" title="project settings" aria-label="settings for ' + esc(p.name) + '">' + ICONS.gear + "</button></div>" +
          '<div class="m">baton ' + esc(p.holder || "\u2014") +
          (p.costUsd > 0 ? " \u00b7 " + money(p.costUsd) : "") + "</div></div>";
        if (open) {
          // A project holds conversations. The agents that work them live in
          // the rail's roster — they belong to the project, not to one chat.
          var chats = p.chats || [{ id: "main", title: "Main", createdAt: 0 }];
          rows += chats.map(function(c){
            var curC = c.id === currentChat();
            return '<div class="crow' + (curC ? " cur" : "") + '" data-p="' + esc(p.id) +
              '" data-chat="' + esc(c.id) + '"' + (curC ? ' data-current="true"' : "") + ">" +
              '<span class="ci">' + ICONS.chat + "</span>" +
              '<span class="cnm">' + esc(c.title) + "</span>" +
              // Is it working, did it finish, did it fail — from the run's
              // own task rows, so this is a fact Loom already had rather than
              // a guess. A thread that never ran shows nothing at all.
              chatStatusMark(p, c.id) +
              // Who answers here, when the thread has an opinion — so the
              // shape of what's running is readable without opening anything.
              (c.agentId
                ? '<span class="cwho" title="' + esc(c.agentId + (c.model ? " · " + c.model : "")) + '">' +
                  esc(c.model ? c.model.split("/").pop() : c.agentId) + "</span>"
                : "") +
              (c.id === "main"
                ? ""
                : '<button class="cx iconbtn" data-delchat="' + esc(c.id) +
                  '" title="forget this chat" aria-label="forget chat ' + esc(c.title) + '">' + ICONS.x + "</button>") +
              "</div>";
          }).join("");
          rows += '<div class="crow add" data-newchat="' + esc(p.id) + '">' +
            '<span class="ci">' + ICONS.plus + '</span><span class="cnm">New chat</span></div>';
        }
        return '<div class="sgroup">' + rows + "</div>";
      }).join("");

      drawChatHits(el);

      Array.prototype.forEach.call(el.querySelectorAll(".srow"), function(row){
        row.onclick = function(){ select(row.getAttribute("data-id")); };
        row.oncontextmenu = function(ev){
          ev.preventDefault();
          ev.stopPropagation();
          projectMenu(row.getAttribute("data-id"), ev.clientX, ev.clientY);
        };
      });
      // The gear opens that project's settings without selecting it.
      Array.prototype.forEach.call(el.querySelectorAll("[data-pset]"), function(btn){
        btn.onclick = function(ev){ ev.stopPropagation(); openProjectSettings(btn.getAttribute("data-pset")); };
      });
      // The caret opens/closes a project's chats without selecting it — so you
      // can peek at another project's conversations while staying in this one.
      // Selecting a project still auto-opens it (isProjOpen falls back to sel),
      // so the common path needs no extra click.
      Array.prototype.forEach.call(el.querySelectorAll("[data-caret]"), function(btn){
        btn.onclick = function(ev){
          ev.stopPropagation();
          var id = btn.getAttribute("data-caret");
          toggleProj(id, id === cur);
          drawList();
        };
      });
      // A hit takes you to the conversation it's in. It doesn't scroll to the
      // message yet — the thread loads its own tail — so this is honest about
      // being "open the chat", not "jump to line".
      Array.prototype.forEach.call(el.querySelectorAll("[data-hit-chat]"), function(row){
        row.onclick = function(){ setChat(cur, row.getAttribute("data-hit-chat")); };
      });
      // Switch conversation. Same project, same brain, same baton — a
      // different thread of talking.
      Array.prototype.forEach.call(el.querySelectorAll(".crow[data-chat]"), function(row){
        row.onclick = function(){
          var pidC = row.getAttribute("data-p"), cid = row.getAttribute("data-chat");
          setChat(pidC, cid);
        };
        row.oncontextmenu = function(ev){
          ev.preventDefault();
          ev.stopPropagation();
          chatMenu(row.getAttribute("data-p"), row.getAttribute("data-chat"), ev.clientX, ev.clientY);
        };
      });
      Array.prototype.forEach.call(el.querySelectorAll("[data-delchat]"), function(b){
        b.onclick = function(ev){
          ev.stopPropagation();
          var cid = b.getAttribute("data-delchat");
          api("/api/projects/" + cur + "/chats/" + cid, { method: "DELETE" })
            .then(function(){
              // its events stay in the log; only the listing goes
              if (currentChat() === cid) setChat(cur, "main");
              refresh();
              toast("chat forgotten \u00b7 its history stays in the brain");
            })
            .catch(function(err){ toast(err.message); });
        };
      });
      // Double-click to rename a conversation — it's your name for it.
      Array.prototype.forEach.call(el.querySelectorAll(".crow[data-chat]"), function(row){
        var cid = row.getAttribute("data-chat");
        if (cid === "main") return; // main's name isn't yours to change
        row.ondblclick = function(ev){
          ev.stopPropagation();
          var nm = row.querySelector(".cnm");
          if (!nm || nm.querySelector("input")) return;
          var was = nm.textContent;
          var inp = document.createElement("input");
          inp.className = "chatinput";
          inp.value = was;
          inp.maxLength = 60;
          nm.textContent = "";
          nm.appendChild(inp);
          inp.focus(); inp.select();
          var done = false;
          function finish(save){
            if (done) return; done = true;
            var next = inp.value.trim();
            if (!save || !next || next === was) { drawList(); return; }
            api("/api/projects/" + cur + "/chats/" + cid + "/rename",
                { method: "POST", body: JSON.stringify({ title: next }) })
              .then(function(){ refresh(); })
              .catch(function(err){ toast(err.message); drawList(); });
          }
          inp.onkeydown = function(e){
            if (e.key === "Enter") { e.preventDefault(); finish(true); }
            else if (e.key === "Escape") { e.preventDefault(); finish(false); }
          };
          inp.onblur = function(){ finish(true); };
          inp.onclick = function(e){ e.stopPropagation(); };
        };
      });
      // Every open project has a New chat row now, not just the selected one.
      Array.prototype.forEach.call(el.querySelectorAll("[data-newchat]"), function(addRow){
        addRow.onclick = function(ev){
          ev.stopPropagation();
          var pidN = addRow.getAttribute("data-newchat");
          var proj = (state.projects || []).filter(function(p){ return p.id === pidN; })[0];
          openChatAgentPick(addRow, proj, function(agentId){ createChatWith(pidN, agentId); });
        };
      });
    }

    /**
     * Make a chat and start it on the agent you chose.
     *
     * It used to mean "hand this agent the baton", because the baton was the
     * only answer to "who answers here" — which is also why a new chat always
     * landed on whoever happened to be holding it. A thread can now name its
     * own agent, so picking one PINS it: the thread answers with that agent
     * without disturbing whatever is working elsewhere.
     */
    function createChatWith(pidN, agentId){
      var proj = (state.projects || []).filter(function(p){ return p.id === pidN; })[0];
      var picked = proj && (proj.agents || []).filter(function(a){ return a.id === agentId; })[0];
      // An adapter is PINNED to the thread rather than handed the baton: the
      // thread then answers with it wherever the baton happens to be, which is
      // what lets two threads talk to two agents at once. A bridge can't take
      // a turn at all, so the composer is aimed at it and its own ask-flow
      // does the rest, as before.
      var pin = picked && picked.tier === "adapter" ? agentId : null;
      var body = pin ? JSON.stringify({ agentId: pin }) : "{}";
      api("/api/projects/" + pidN + "/chats", { method: "POST", body: body })
        .then(function(j){
          state.pendingSelect = agentId || null;
          refresh();
          setChat(pidN, j.chat.id);
        })
        .catch(function(err){ toast(err.message); });
    }


  /**
   * The dot on a thread row: running, done, failed, waiting — or nothing.
   *
   * Every answer comes from something the daemon already reports: an orchestra
   * task's own status, and the project's needsInput. Nothing here infers
   * "done" from silence — a thread whose agent went away is not running, and
   * it is not finished either, so it says nothing rather than something wrong.
   */
  function chatStatusMark(p, chatId){
    var run = p && p.orchestra;
    var rows = (run && run.threads) || [];
    var t = null;
    for (var i = 0; i < rows.length; i++) if (rows[i].chat === chatId) { t = rows[i]; break; }
    // The run's own thread carries the run's own status.
    if (!t && run && run.chat === chatId) {
      if (run.status === "running" || run.status === "planning") {
        return '<span class="cstat run" title="this goal is running"></span>';
      }
      if (run.status === "waiting_human") return '<span class="cstat wait" title="this goal is waiting on you"></span>';
      if (run.status === "completed") return '<span class="cstat done" title="this goal finished"></span>';
      if (run.status === "failed" || run.status === "aborted") {
        return '<span class="cstat bad" title="this goal ' + esc(run.status) + '"></span>';
      }
    }
    if (!t) return "";
    if (t.status === "running") return '<span class="cstat run" title="' + esc(t.agent) + ' is working on this"></span>';
    if (t.status === "done") return '<span class="cstat done" title="finished"></span>';
    if (t.status === "failed" || t.status === "cancelled") {
      return '<span class="cstat bad" title="' + esc(t.status) + '"></span>';
    }
    if (t.status === "blocked" || t.status === "waiting") {
      return '<span class="cstat wait" title="' + esc(t.status) + '"></span>';
    }
    return '<span class="cstat idle" title="not started"></span>';
  }

  /** A little popover of a project's agents, anchored to the New chat row. */
    function openChatAgentPick(anchor, proj, onPick){
      closeAgentPick();
      var agents = (proj && proj.agents) || [];
      if (!agents.length) { onPick(null); return; } // nothing to choose — just make it
      var pop = document.createElement("div");
      pop.className = "pickpop"; pop.id = "chatpick";
      pop.innerHTML = '<div class="pickhead">start this chat with</div>' +
        agents.map(function(a){
          var bridge = a.tier === "bridge";
          return '<button class="pickrow" data-pick="' + esc(a.id) + '">' +
            brandMark(a.kind) + '<span class="pnm">' + esc(a.id) + "</span>" +
            '<span class="prole">' + esc(bridge ? "bridge" : a.role) + "</span></button>";
        }).join("");
      document.body.appendChild(pop);
      var r = anchor.getBoundingClientRect();
      pop.style.left = Math.round(r.left) + "px";
      pop.style.top = Math.round(r.bottom + 4) + "px";
      // If it would fall off the bottom, flip above the row.
      var ph = pop.getBoundingClientRect().height;
      if (r.bottom + 4 + ph > window.innerHeight) pop.style.top = Math.max(8, Math.round(r.top - ph - 4)) + "px";
      Array.prototype.forEach.call(pop.querySelectorAll("[data-pick]"), function(b){
        b.onclick = function(ev){ ev.stopPropagation(); var id = b.getAttribute("data-pick"); closeAgentPick(); onPick(id); };
      });
      setTimeout(function(){
        document.addEventListener("mousedown", agentPickAway);
      }, 0);
    }
    function agentPickAway(ev){
      var pop = document.getElementById("chatpick");
      if (pop && !pop.contains(ev.target)) closeAgentPick();
    }
    function closeAgentPick(){
      document.removeEventListener("mousedown", agentPickAway);
      var pop = document.getElementById("chatpick");
      if (pop) pop.remove();
    }
    /**
     * Right-click a project: everything you can do to it, where you clicked.
     *
     * These were scattered — settings behind a gear, rename nowhere, and
     * removing a project only in loom projects --forget. A context menu is
     * where people look for them, and it costs nothing to put them there.
     */
    function projectMenu(pid, x, y){
      var p = (state.projects || []).filter(function(q){ return q.id === pid; })[0];
      if (!p) return;
      openMenu(x, y, [
        { head: p.name },
        { label: "Open", icon: ICONS.thread, run: function(){ select(pid); } },
        { label: "New chat", icon: ICONS.chat, run: function(){
            var row = document.querySelector('[data-newchat="' + pid + '"]');
            if (row) row.click(); else { select(pid); toast("open the project to start a chat"); }
          } },
        { sep: true },
        { label: "Project settings…", icon: ICONS.gear, run: function(){ openProjectSettings(pid); } },
        { label: "Rename…", icon: ICONS.file, run: function(){ renameProject(pid, p.name); } },
        { label: "Copy path", icon: ICONS.copy, hint: "folder", run: function(){ copyText(p.dir || ""); } },
        { sep: true },
        // NOT "Delete": this unregisters the project and leaves every file
        // where it is. A menu item that says delete and doesn't, or says
        // delete and does, are both worse than one that says what happens.
        { label: "Remove from Loom", icon: ICONS.trash, danger: true, run: function(){ forgetProject(pid, p.name); } },
      ]);
    }

    /**
     * Right-click a thread. Double-click already renamed one and the ✕ already
     * forgot one; this is where you look for them, plus the binding that only
     * existed when you created the thread.
     */
    function chatMenu(pid, cid, x, y){
      var p = (state.projects || []).filter(function(q){ return q.id === pid; })[0];
      var c = ((p && p.chats) || []).filter(function(q){ return q.id === cid; })[0] || { id: cid, title: "Main" };
      var isMain = cid === "main";
      var items = [
        { head: c.title },
        { label: "Open", icon: ICONS.chat, run: function(){ setChat(pid, cid); } },
        { sep: true },
        { label: "Answered by…", icon: ICONS.agents, hint: c.agentId || "the baton", run: function(){
            var row = document.querySelector('.crow[data-chat="' + cid + '"]');
            openChatAgentPick(row || document.body, p, function(agentId){ bindChat(pid, cid, agentId); });
          } },
      ];
      // Main follows the baton and its name is not yours to change — the menu
      // says so by not offering, rather than by offering and refusing.
      if (!isMain) {
        items.push({ label: "Rename…", icon: ICONS.file, run: function(){ renameChat(pid, cid, c.title); } });
        items.push({ sep: true });
        items.push({ label: "Forget this chat", icon: ICONS.trash, danger: true, run: function(){ forgetChat(pid, cid); } });
      }
      openMenu(x, y, items);
    }

    function bindChat(pid, cid, agentId){
      if (cid === "main") { toast("the main thread follows the baton"); return; }
      api("/api/projects/" + pid + "/chats/" + cid + "/agent",
          { method: "POST", body: JSON.stringify({ agentId: agentId || null }) })
        .then(function(){ refresh(); toast(agentId ? "this thread answers with " + agentId : "back to following the baton"); })
        .catch(function(err){ toast(err.message); });
    }

    function renameChat(pid, cid, was){
      var next = window.prompt("Rename this chat", was || "");
      if (next === null) return;
      next = next.trim();
      if (!next || next === was) return;
      api("/api/projects/" + pid + "/chats/" + cid + "/rename", { method: "POST", body: JSON.stringify({ title: next }) })
        .then(function(){ refresh(); })
        .catch(function(err){ toast(err.message); });
    }

    function forgetChat(pid, cid){
      api("/api/projects/" + pid + "/chats/" + cid, { method: "DELETE" })
        .then(function(){
          if (currentChat() === cid) setChat(pid, "main");
          refresh();
          toast("chat forgotten · its history stays in the brain");
        })
        .catch(function(err){ toast(err.message); });
    }

    /** Rename in place, from the menu — the same call the settings pane makes. */
    function renameProject(pid, was){
      var next = window.prompt("Rename this project", was || "");
      if (next === null) return;
      next = next.trim();
      if (!next || next === was) return;
      api("/api/projects/" + pid, { method: "PATCH", body: JSON.stringify({ name: next }) })
        .then(function(){ refresh(); toast("renamed"); })
        .catch(function(err){ toast(err.message); });
    }

    /**
     * Stop tracking a project. Its directory, its .loom/ and its history stay
     * exactly where they are — which is why the confirm says so rather than
     * asking "are you sure?" about something it hasn't described.
     */
    function forgetProject(pid, name){
      if (!window.confirm('Remove "' + name + '" from Loom?\n\nIts folder, its history and its .loom directory stay on disk. Add the folder again to bring it back.')) return;
      api("/api/projects/" + pid, { method: "DELETE" })
        .then(function(){
          if (pid === cur) { cur = null; try { localStorage.removeItem("loomProject"); } catch (e) {} }
          refresh();
          toast("removed from Loom — the folder is untouched");
        })
        .catch(function(err){ toast(err.message); });
    }

    function select(pid){
      cur = pid;
      wanted = null; // whatever the URL wanted, this is a real choice now
      history.replaceState(null, "", "#p/" + pid);
      renderProject(pid, dmain, true);
      drawList();
    }
    state.selectProject = select;
    state.setChat = setChat; // the palette jumps to a conversation by id
    /** The conversation you're in, per project, remembered across reloads. */
    function currentChat(){
      if (!cur) return "main";
      try { return localStorage.getItem("loomChat:" + cur) || "main"; } catch (e) { return "main"; }
    }
    function setChat(pidC, cid){
      try { localStorage.setItem("loomChat:" + pidC, cid); } catch (e) {}
      if (pidC !== cur) { select(pidC); return; }
      state.chat = cid;
      renderProject(cur, dmain, true); // reload the thread for this chat
      drawList();
    }
    state.currentChat = currentChat;
    function refresh(){
      api("/api/projects").then(function(j){
        state.projects = j.projects || [];
        if (!state.projects.length) { drawList(); drawEmpty(); drawStatusbar(); return; }
        var exists = state.projects.some(function(p){ return p.id === cur; });
        if (!document.getElementById("feed")) select(cur && exists ? cur : state.projects[0].id);
        // A link to a project this client has never listed — one just created,
        // or a URL from another device — loses a race: the first /api/projects
        // reply doesn't contain it, the exists check is false, and it quietly
        // opens projects[0] instead. The project then turns up in the sidebar a
        // poll later while the address bar still reads #p/<the other one>, and
        // you are looking at a project you did not ask for with no sign that
        // anything went wrong.
        //
        // wanted is cleared by select(), so this fires at most once and never
        // yanks the view back after you have clicked somewhere yourself.
        else if (wanted && wanted !== cur && state.projects.some(function(p){ return p.id === wanted; })) select(wanted);
        else drawList();
        drawStatusbar();
      }).catch(function(err){ toast(err.message); });
    }
    if (!cur) drawEmpty();
    drawStatusbar();
    refresh();
    loadGithub(); // fills the status-bar GitHub badge
    loadUpdate(); // and whether a newer Loom is published
    loadLoomPad(); // fills the status-bar LoomPad connectivity pill
    state.shellTimer = setInterval(refresh, 5000);
  }
export { clearShell,isDesktop,mq,renderShell };
