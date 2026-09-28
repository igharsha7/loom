import { agentGlyph,agentLabel,agentSub,labelOf } from '../agents.js';
import { api } from '../connection.js';
import { clog } from '../console.js';
import { esc,rel } from '../format.js';
import { ICONS,LOADER } from '../icons.js';
import { openMenu } from '../menus.js';
import { toast } from '../notifications.js';
import { KMOD,PERM_MODES,PERM_NAMES,PERM_SHORT,loadPermProfiles,permOf,permProfile,permSplit } from '../permissions.js';
import { state } from '../state.js';
import { showContinuityOverflow } from './continuity.js';
import { openTaskModal } from '../tasks.js';
import { setTView,tview } from '../transcript.js';

/** composer behavior for one mounted project.
 * view contains live accessors to the owning project view's state and callbacks.
 * Creating this module only binds functions; startup and cleanup belong to project.js.
 */
export function createComposer(view) {
    var pendingSubmission;


    function send(){
      if (state.cmode === "orch") return view.sendOrchestra();
      var box = document.getElementById("box");
      var text = (box.value || "").trim();
      // A message can be pure attachments — "look at this" with an image.
      if (!text && !view.attach.length) return;
      if (view.attach.some(function(a){ return a.uploading; })) { toast("still uploading\u2026"); return; }

      // Path references go first, so an agent reads the file before the ask.
      var refs = view.attach.map(function(a){
        return (a.kind === "image" ? "[image] " : "[file] ") + a.path;
      });
      var full = refs.length ? refs.join("\n") + (text ? "\n\n" + text : "") : text;

      box.value = ""; autosizeBox(); view.attach = []; drawAttach();
      var p = state.project || {};
      var plan = view.planState;

      // An orchestra's own thread talks to its orchestrator: a reply answers
      // its question, or steers the run mid-flight (and reopens a finished
      // one). Sending it to an agent instead would run that agent in the
      // project checkout, outside the run's worktrees.
      var orun = view.orchRunForChat();
      if (orun && orun.status !== "aborted") {
        api("/api/projects/" + view.pid + "/orchestra/" + encodeURIComponent(orun.id) + "/reply", {
          method: "POST", body: JSON.stringify({ text: full }),
        }).then(function(j){ if (j && j.run) view.mergeOrchRun(j.run); view.refresh(); })
          .catch(function(err){ toast(err.message); });
        return;
      }

      // A bridge is driven, not handed a turn: Loom types into Antigravity's or
      // Kiro's own window and waits for the panel to settle. No handoff, because
      // it never takes the baton — whichever adapter holds it keeps it.
      var sel = (p.agents || []).filter(function(a){ return a.id === state.selected; })[0];
      if (sel && sel.tier === "bridge") {
        // A bridge types into someone else's window; Loom can't brief it into
        // plan mode, so say so rather than let the switch quietly lie.
        toast(plan ? "plan mode doesn\u2019t reach bridges \u2014 typing into " + sel.id + " as-is" : "typing into " + sel.id + "\u2026");
        api("/api/projects/" + view.pid + "/bridge/" + encodeURIComponent(sel.id) + "/ask", {
          method: "POST", body: JSON.stringify({ text: full, chat: view.chatId }),
        }).then(function(){ view.refresh(); }).catch(function(err){
          // The bridge's own words ("log in from its window", "launch it
          // with…") are the actionable part; don't bury them.
          toast(err.message);
          view.refresh();
        });
        view.refresh();
        return;
      }

      // AUTO mode: don't pick an agent — let the dynamic router decide who takes
      // this turn (planner/builder/reviewer) based on the prompt + hop history.
      // (Plan mode skips the router: a route hops between agents doing the work,
      // and a plan is one agent's to write — the baton holder's.)
      if (state.auto && !plan) {
        var achip = document.getElementById("cagent");
        if (achip) achip.classList.add("routing");
        api("/api/projects/" + view.pid + "/route", { method: "POST", body: JSON.stringify({ task: full, spec: "auto" }) })
          .then(view.refresh).catch(function(err){ toast(err.message); })
          .then(function(){ if (achip) achip.classList.remove("routing"); });
        return;
      }

      // Something is already running, or prompts are already lined up: this
      // one joins the queue rather than being refused or jumping the line.
      if (view.wouldQueue()) {
        view.queueFromComposer(full, plan).catch(function(err){
          toast(err.message);
          box.value = full; autosizeBox(); // a refused queue leaves what you wrote where you wrote it
        });
        return;
      }

      var chain = Promise.resolve();
      if (!p.continuity && !state.auto && state.selected && state.selected !== p.holder) {
        chain = api("/api/projects/" + view.pid + "/handoff", { method: "POST", body: JSON.stringify({ to: state.selected }) });
      }
      chain.then(function(){
        // into the chat you're looking at — the agent's reply comes back here
        var body = { text: full, agentId: (state.auto ? undefined : state.selected) || undefined, chat: view.chatId, plan: plan || undefined };
        if(p.continuity) {
          var key = JSON.stringify(body);
          if(!pendingSubmission || pendingSubmission.key !== key) pendingSubmission = { key: key, id: crypto.randomUUID() };
          body.requestId = pendingSubmission.id;
        }
        return api("/api/projects/" + view.pid + "/messages", { method: "POST", body: JSON.stringify(body) });
      }).then(function(result){
        pendingSubmission = null;
        view.refresh();
        if (result && result.continuityStatus === "overflow") showContinuityOverflow(view, result);
        else if (result && result.continuityStatus === "outcome_unknown") toast("Native delivery outcome is uncertain. Review Brain continuity diagnostics before retrying.");
      }).catch(function(err){ toast(err.message); if(p.continuity && !box.value) { box.value = full; autosizeBox(); } });
    }




    // ---- composer plumbing -------------------------------------------------

    function autosizeBox(){
      var box = document.getElementById("box"); if (!box) return;
      box.style.height = "auto";
      // floor at two lines (48px), grow to a cap, then let it scroll
      box.style.height = Math.max(48, Math.min(200, box.scrollHeight)) + "px";
    }


    function drawAttach(){
      var wrap = document.getElementById("cchips"); if (!wrap) return;
      if (!view.attach.length) { wrap.style.display = "none"; wrap.innerHTML = ""; return; }
      wrap.style.display = "flex";
      wrap.innerHTML = view.attach.map(function(a, i){
        var thumb = a.thumb ? '<img src="' + a.thumb + '" alt="">' : ICONS.file;
        return '<span class="cchip' + (a.uploading ? " up" : "") + '">' + thumb +
          '<span class="nm">' + esc(a.uploading ? a.name + "\u2026" : (a.path || a.name)) + "</span>" +
          '<button class="rm" type="button" data-rm="' + i + '" aria-label="remove attachment">' + ICONS.x + "</button></span>";
      }).join("");
      Array.prototype.forEach.call(wrap.querySelectorAll("[data-rm]"), function(b){
        b.onclick = function(){ view.attach.splice(Number(b.getAttribute("data-rm")), 1); drawAttach(); };
      });
    }


    function uploadFile(file){
      var isImg = /^image\//.test(file.type);
      var rec = { name: file.name || (isImg ? "pasted-image" : "file"), kind: isImg ? "image" : "file", uploading: true, thumb: null, path: null };
      view.attach.push(rec); drawAttach();
      var reader = new FileReader();
      reader.onload = function(){
        var dataUrl = reader.result;
        if (isImg) rec.thumb = dataUrl;
        api("/api/projects/" + view.pid + "/attachments", {
          method: "POST", body: JSON.stringify({ name: rec.name, dataUrl: dataUrl }),
        }).then(function(j){
          rec.uploading = false; rec.path = j.path; drawAttach();
        }).catch(function(err){
          var i = view.attach.indexOf(rec); if (i >= 0) view.attach.splice(i, 1);
          drawAttach(); toast("attach failed: " + err.message);
        });
      };
      reader.onerror = function(){
        var i = view.attach.indexOf(rec); if (i >= 0) view.attach.splice(i, 1);
        drawAttach(); toast("could not read that file");
      };
      reader.readAsDataURL(file);
    }


    /** "2 on" / "none yet" — what the Skills row says without opening it. */
  function skillHint(){
    if (!state.skillsTotal) return "none yet";
    return state.skillsOn ? state.skillsOn + " on" : "off";
  }


  function closeMenu(){
      view.menuState = null;
      document.removeEventListener("mousedown", menuAway);
      // the prompt manager dresses #cmenu up as a bigger glass panel; undress it
      var m = document.getElementById("cmenu"); if (m) { m.style.display = "none"; m.innerHTML = ""; m.className = "cmenu"; }
      var pb = document.getElementById("promptbtn"); if (pb) pb.classList.remove("on");
    }

    // The model/agent pickers open from a button, not the textarea, so a blur
    // won't close them — a click anywhere outside the card does.
    function menuAway(e){
      // A click that re-rendered its own row (pinning a prompt) leaves a
      // detached target, which no card "contains" — that isn't a click away.
      if (e.target && e.target.isConnected === false) return;
      var cb = document.querySelector(".cbox");
      if (cb && !cb.contains(e.target)) closeMenu();
    }


    function renderMenu(items, head){
      var m = document.getElementById("cmenu"); if (!m) return;
      if (!items.length) { closeMenu(); return; }
      view.menuState.items = items; if (view.menuState.sel == null) view.menuState.sel = 0;
      if (view.menuState.sel >= items.length) view.menuState.sel = items.length - 1;
      m.style.display = "block"; m.className = "cmenu";
      m.innerHTML = (head ? '<div class="cmhead">' + esc(head) + "</div>" : "") +
        items.map(function(it, i){
          return '<div class="cmi' + (i === view.menuState.sel ? " sel" : "") + '" data-i="' + i + '">' +
            '<span class="ic">' + (it.icon || ICONS.file) + "</span>" +
            "<span>" + esc(it.label) + "</span>" +
            (it.sub ? '<span class="sub">' + esc(it.sub) + "</span>" : "") + "</div>";
        }).join("");
      Array.prototype.forEach.call(m.querySelectorAll(".cmi"), function(row){
        row.onmousedown = function(ev){ ev.preventDefault(); acceptMenu(Number(row.getAttribute("data-i"))); };
      });
    }


    function acceptMenu(i){
      if (!view.menuState || !view.menuState.items) return;
      var it = view.menuState.items[i]; if (!it) return;
      var act = view.menuState.kind;
      if (act === "file") {
        var box = document.getElementById("box");
        var v = box.value, from = view.menuState.at, to = box.selectionStart;
        box.value = v.slice(0, from) + it.value + " " + v.slice(to);
        var caret = from + it.value.length + 1;
        box.setSelectionRange(caret, caret); box.focus(); autosizeBox();
        closeMenu();
      } else if (act === "cmd") {
        // A command consumes the whole "/word" it matched.
        var box2 = document.getElementById("box");
        box2.value = box2.value.slice(0, view.menuState.at) + box2.value.slice(box2.selectionStart);
        box2.setSelectionRange(view.menuState.at, view.menuState.at); autosizeBox();
        closeMenu();
        it.run();
      }
    }


    // Static, and every one runs something real — no decorative commands.
    function slashCommands(){
      return [
        { label: "New task", sub: "hand work to one or more agents", icon: ICONS.tasks, run: function(){ openTaskModal(view.pid); } },
        { label: "Record a decision", sub: "save it to the brain", icon: ICONS.memory, run: function(){
            var box = document.getElementById("box");
            var t = (box.value || "").trim();
            if (!t) { toast("type the decision first, then /"); return; }
            box.value = ""; autosizeBox();
            api("/api/projects/" + view.pid + "/decisions", { method: "POST", body: JSON.stringify({ text: t }) })
              .then(function(){ toast("decision saved to the brain"); if (typeof view.refreshBrain === "function") view.refreshBrain(); })
              .catch(function(err){ toast(err.message); });
          } },
        { label: "Pick a model", sub: "for " + (state.selected || "this agent"), icon: ICONS.gear, run: openModelMenu },
        { label: "Attach a file", sub: "image, .md, .txt", icon: ICONS.file, run: function(){ var f = document.getElementById("cfile"); if (f) f.click(); } },
        { label: "Browse skills", sub: "install one, or turn one on", icon: ICONS.spark, run: function(){ openSkillsModal(view.pid); } },
        { label: "MCP servers", sub: "browse the registry and install", icon: ICONS.plug, run: function(){ openMcpModal(view.pid); } },
      ].concat(skillSlashItems());
    }

    /**
     * Every skill, right in the "/" menu.
     *
     * Enabling a skill is the thing you want mid-sentence — you start typing,
     * realise this turn needs the triage skill, and you should not have to leave
     * the composer to say so. The list is the same catalog the modal browses; it
     * is cached on the composer so typing "/" doesn't refetch on every keystroke.
     */
    function skillSlashItems(){
      var list = state.skillCache || [];
      return list.map(function(s){
        return {
          label: (s.enabled ? "\u2713 " : "") + (s.name || s.id),
          sub: s.enabled ? "skill \u00b7 on \u2014 select to turn off" : "skill \u00b7 " + ((s.description || "").slice(0, 54) || "turn on for this project"),
          icon: ICONS.spark,
          run: function(){
            api("/api/projects/" + view.pid + "/skills/" + encodeURIComponent(s.id), { method: "PUT", body: JSON.stringify({ enabled: !s.enabled }) })
              .then(function(){
                s.enabled = !s.enabled;
                toast((s.enabled ? "enabled " : "disabled ") + (s.name || s.id));
                refreshSkillCount();
              })
              .catch(function(err){ toast(err.message); });
          }
        };
      });
    }

    /** Keep the "/" menu's skill list fresh without refetching per keystroke. */
    function loadSkillCache(){
      api("/api/projects/" + view.pid + "/skills/catalog")
        .catch(function(){ return api("/api/projects/" + view.pid + "/skills"); })
        .then(function(r){ state.skillCache = r.skills || []; })
        .catch(function(){ state.skillCache = []; });
    }


    function openFileMenu(q, at){
      view.menuState = { kind: "file", at: at, sel: 0, items: [] };
      api("/api/projects/" + view.pid + "/find?q=" + encodeURIComponent(q))
        .then(function(j){
          if (!view.menuState || view.menuState.kind !== "file") return;
          var items = (j.matches || []).slice(0, 40).map(function(pth){
            var base = pth.split("/").pop();
            return { label: base, sub: pth, value: "@" + pth, icon: ICONS.file };
          });
          renderMenu(items, "files");
        })
        .catch(function(){ closeMenu(); });
    }


    function openModelMenu(who){
      // Orchestrate has no "selected" agent — it has a cast — so the caller
      // names the one it means. Chat still means whoever the composer is aimed at.
      var agentId = who || state.selected;
      var p = state.project || {};
      var cur = (p.agents || []).filter(function(a){ return a.id === agentId; })[0];
      if (!cur || cur.tier === "bridge") { toast("pick an adapter first \u2014 bridges choose their own model"); return; }
      var m = document.getElementById("cmenu"); if (!m) return;
      view.menuState = { kind: "modelmenu", agent: agentId, at: 0, sel: 0, items: [] };
      m.style.display = "block"; m.className = "cmenu";
      m.innerHTML = '<div class="cmhead">model \u00b7 ' + esc(cur.id) + '</div>' +
        '<input class="cmsearch" id="cmsearch" placeholder="search real models\u2026" spellcheck="false" autocomplete="off">' +
        '<div class="cmlist" id="cmlist">' + LOADER + '</div>';
      setTimeout(function(){ document.addEventListener("mousedown", menuAway); }, 0);
      var active = cur.model || "";
      var allModels = [];
      function choose(val){
        if (val === "__custom__"){ closeMenu(); var typed = window.prompt("Model for " + cur.id + " (blank = default):", active); if (typed === null) return; val = typed.trim(); }
        else closeMenu();
        setModel(agentId, val);
      }
      // The real models the tool itself reports (opencode ~500 across providers,
      // grok its own); codex/claude are their shipped sets.
      function render(filter){
        var f = (filter || "").trim().toLowerCase();
        var shown = f ? allModels.filter(function(mm){ return mm.toLowerCase().indexOf(f) >= 0; }) : allModels;
        var cap = 200; // don't paint 500 rows — the search narrows it
        var head = cur.kind === "model" ? []
          : [{ label: "Default", sub: cur.kind + "'s own choice", value: "" }];
        if (!f) head.push({ label: "Custom\u2026", value: "__custom__", plus: true });
        var rows = head.concat(shown.slice(0, cap).map(function(mm){ return { label: mm, value: mm }; }));
        var list = document.getElementById("cmlist"); if (!list) return;
        list.innerHTML = rows.map(function(it){
          var tick = it.value === active;
          return '<div class="cmi" data-mv="' + esc(String(it.value)) + '"><span class="ic">' + (it.plus ? ICONS.plus : ICONS.gear) + '</span><span>' +
            esc(it.label) + '</span>' + (tick ? '<span class="tick">' + ICONS.info + '</span>' : (it.sub ? '<span class="sub">' + esc(it.sub) + '</span>' : '')) + '</div>';
        }).join("") +
          (shown.length > cap ? '<div class="cmmore">' + (shown.length - cap) + ' more \u2014 keep typing to narrow</div>' : "") +
          (f && !shown.length ? '<div class="cmmore">no match \u00b7 Enter to use \u201c' + esc(filter) + '\u201d</div>' : "");
        Array.prototype.forEach.call(list.querySelectorAll("[data-mv]"), function(row){
          row.onmousedown = function(ev){ ev.preventDefault(); choose(row.getAttribute("data-mv")); };
        });
      }
      api("/api/projects/" + view.pid + "/agents/" + encodeURIComponent(agentId) + "/models").then(function(j){
        allModels = (j && j.models) || [];
        // Say where the list came from. "asked the tool" and "the aliases we
        // ship" are different claims, and only one of them goes stale silently.
        var mn = document.getElementById("cmenu");
        if (mn && j && j.source){
          var note = j.source === "cli" ? "asked " + esc(cur.kind || "the tool")
            : j.source === "api" ? "asked every provider with a key \u2014 " + (j.count || 0) + " models"
            : j.source === "builtin" ? esc(cur.kind || "this tool") + " can\u2019t list models \u2014 these are its documented aliases"
            : "no model list for this agent";
          var ft = document.createElement("div");
          ft.className = "cmfoot"; ft.textContent = note;
          mn.appendChild(ft);
        }
        var sb = document.getElementById("cmsearch");
        if (sb){
          var head0 = document.getElementById("cmlist");
          sb.oninput = function(){ render(sb.value); };
          sb.onkeydown = function(e){ if (e.key === "Enter"){ var v = sb.value.trim(); if (v) choose(v); } if (e.key === "Escape"){ closeMenu(); } };
          sb.focus();
        }
        render("");
      }).catch(function(err){
        var list = document.getElementById("cmlist"); if (list) list.innerHTML = '<div class="cmmore">could not list models</div>';
        clog("error", "models", "list failed: " + (err && err.message), err && err.stack);
      });
    }


    /**
     * Who this chat talks to. The agent chip in the composer was a dead label —
     * you could see "opencode" but not change it without hunting the sidebar.
     * Now it's a real picker: every agent in the project, brand mark and role,
     * the current one ticked. Selecting one aims the composer (state.selected);
     * send then hands it the baton.
     */
    function openAgentMenu(){
      var p = state.project || {};
      var agents = p.agents || [];
      if (!agents.length) { toast("no agents in this project yet"); return; }
      view.menuState = { kind: "agentmenu", at: 0, sel: 0, items: [] };
      var m = document.getElementById("cmenu"); if (!m) return;
      m.style.display = "block"; m.className = "cmenu";
      // AUTO leads the list — it's the "let the system choose" option, not an agent.
      m.innerHTML = '<div class="cmhead">who runs this turn</div>' +
        '<div class="cmi cmauto' + (state.auto ? " on" : "") + '" data-auto="1"><span class="ic"><span class="autodot"></span></span><span>AUTO</span>' +
          (state.auto ? '<span class="tick">' + ICONS.info + "</span>" : '<span class="sub">smart routing</span>') + "</div>" +
        agents.map(function(a, i){
          var tick = !state.auto && a.id === state.selected;
          var lbl = agentLabel(a.kind, a.id);
          // the product name leads; the roster id follows when it says more
          // (two Claude Codes with different roles are told apart by it)
          var sub = agentSub(a, lbl);
          return '<div class="cmi" data-ai="' + i + '"><span class="ic">' + agentGlyph(a.kind, a.id) + "</span><span>" + esc(lbl) + "</span>" +
            (a.busy ? '<span class="cmbusy">working</span>' : "") +
            (tick ? '<span class="tick"' + (a.busy ? ' style="margin-left:6px"' : "") + ">" + ICONS.info + "</span>"
              : (sub && !a.busy ? '<span class="sub">' + esc(sub) + "</span>" : "")) + "</div>";
        }).join("") +
        // Cursor is on its way; listing it (inert) says so where you'd look for it.
        '<div class="cmsep"></div><div class="cmi soon" aria-disabled="true"><span class="ic">' + agentGlyph("", "cursor") +
          '</span><span>Cursor</span><span class="sub">coming soon</span></div>';
      var auto = m.querySelector("[data-auto]");
      if (auto) auto.onmousedown = function(ev){ ev.preventDefault(); closeMenu(); setAuto(true); var box = document.getElementById("box"); if (box) box.focus(); };
      Array.prototype.forEach.call(m.querySelectorAll("[data-ai]"), function(row){
        row.onmousedown = function(ev){
          ev.preventDefault();
          var a = agents[Number(row.getAttribute("data-ai"))];
          closeMenu();
          if (!a) return;
          if (a.id === state.selected && !state.auto) return;
          state.auto = false; // picking an agent turns routing off
          state.selected = a.id;
          view.drawStatus(); // repaints the selector, the model label, and the hint
          var box = document.getElementById("box"); if (box) box.focus();
        };
      });
      setTimeout(function(){ document.addEventListener("mousedown", menuAway); }, 0);
    }


    function setModel(agentId, model){
      api("/api/projects/" + view.pid + "/agents/" + encodeURIComponent(agentId) + "/model", {
        method: "POST", body: JSON.stringify({ model: model }),
      }).then(function(){
        toast(model ? (agentId + " \u2192 " + model) : (agentId + " \u2192 default model"));
        view.refresh();
      }).catch(function(err){ toast(err.message); });
    }


    // What's under the caret: an @file token, or a /command at a word start.
    function scanTrigger(){
      var box = document.getElementById("box");
      if (!box || box.selectionStart !== box.selectionEnd) return closeMenu();
      var upto = box.value.slice(0, box.selectionStart);
      var at = upto.match(/(^|\s)@([\w./-]*)$/);
      if (at) { openFileMenu(at[2], box.selectionStart - at[2].length - 1); return; }
      var sl = upto.match(/(^|\s)\/(\w*)$/);
      if (sl) {
        var start = box.selectionStart - sl[2].length - 1;
        view.menuState = { kind: "cmd", at: start, sel: 0, items: [] };
        var q = sl[2].toLowerCase();
        renderMenu(slashCommands().filter(function(c){ return c.label.toLowerCase().indexOf(q) >= 0; }), "actions");
        return;
      }
      if (view.menuState && (view.menuState.kind === "file" || view.menuState.kind === "cmd")) closeMenu();
    }


    function bindComposer(){
      var box = document.getElementById("box");
      var form = document.getElementById("cform");
      if (!box || !form || box.getAttribute("data-bound")) return;
      box.setAttribute("data-bound", "1");
      autosizeBox();

      box.addEventListener("input", function(){ autosizeBox(); scanTrigger(); scheduleSkillSuggest(box.value); });
      loadSkillCache();
      box.addEventListener("keydown", function(e){
        // Menu open: arrows move, Enter/Tab accept, Esc closes.
        if (view.menuState && view.menuState.items && view.menuState.items.length && (view.menuState.kind === "file" || view.menuState.kind === "cmd")) {
          if (e.key === "ArrowDown") { e.preventDefault(); view.menuState.sel = (view.menuState.sel + 1) % view.menuState.items.length; renderMenu(view.menuState.items, view.menuState.kind === "cmd" ? "actions" : "files"); return; }
          if (e.key === "ArrowUp") { e.preventDefault(); view.menuState.sel = (view.menuState.sel - 1 + view.menuState.items.length) % view.menuState.items.length; renderMenu(view.menuState.items, view.menuState.kind === "cmd" ? "actions" : "files"); return; }
          if (e.key === "Enter" || e.key === "Tab") { e.preventDefault(); acceptMenu(view.menuState.sel); return; }
          if (e.key === "Escape") { e.preventDefault(); closeMenu(); return; }
        }
        // Enter sends; Shift+Enter is a newline.
        if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
      });
      box.addEventListener("paste", function(e){
        var items = (e.clipboardData && e.clipboardData.items) || [];
        var imgs = [];
        for (var i = 0; i < items.length; i++) {
          if (items[i].kind === "file" && /^image\//.test(items[i].type)) {
            var f = items[i].getAsFile(); if (f) imgs.push(f);
          }
        }
        if (imgs.length) { e.preventDefault(); imgs.forEach(uploadFile); }
      });
      // Blur closes only the menus the textarea drives (@ and /). The pickers
      // opened from buttons move focus into their own search box on purpose,
      // and closing them on that blur shut the prompt manager as it opened.
      box.addEventListener("blur", function(){ setTimeout(function(){ if (view.menuState && (view.menuState.kind === "file" || view.menuState.kind === "cmd")) closeMenu(); }, 120); });

      form.addEventListener("submit", function(ev){ ev.preventDefault(); send(); });

      var attachBtn = document.getElementById("attach");
      var fileInput = document.getElementById("cfile");
      if (attachBtn && fileInput) {
        attachBtn.onclick = function(){ fileInput.click(); };
        fileInput.onchange = function(){
          Array.prototype.forEach.call(fileInput.files || [], uploadFile);
          fileInput.value = "";
        };
      }
      var mp = document.getElementById("modelpick");
      if (mp) mp.onclick = function(){
        if (view.menuState && view.menuState.kind === "modelmenu") { closeMenu(); return; }
        openModelMenu();
      };
      // One selector, both jobs: AUTO (the router) sits at the top of the menu,
      // the agents below it.
      var ap = document.getElementById("cagent");
      if (ap) ap.onclick = function(){
        if (view.menuState && view.menuState.kind === "agentmenu") { closeMenu(); return; }
        openAgentMenu();
      };
      Array.prototype.forEach.call(document.querySelectorAll("#cmode [data-cmode]"), function(b){
        b.onclick = function(){ view.setComposerMode(b.getAttribute("data-cmode")); var bx = document.getElementById("box"); if (bx) bx.focus(); };
      });
      var osend = document.getElementById("orchsend");
      if (osend) osend.onclick = view.sendOrchestra;
      var pc = document.getElementById("cperm");
      if (pc) pc.onclick = function(){
        if (view.menuState && view.menuState.kind === "permmenu") { closeMenu(); return; }
        openPermMenu(state.selected);
      };
      var pb = document.getElementById("promptbtn");
      if (pb) pb.onclick = openPrompts;
      state.openPrompts = openPrompts; // ⌘⇧V, from the global key handler
      var plb = document.getElementById("planbtn");
      if (plb) plb.onclick = function(){ setPlan(!view.planState); var bx = document.getElementById("box"); if (bx) bx.focus(); };
      drawPlan();
      // the page may be gone by the time profiles arrive (a closed tab, a torn-down test window)
      loadPermProfiles().then(function(){ if (typeof document === "undefined" || !document) return; updateModelLabel(); view.drawOrchControls(); });
      var moreB = document.getElementById("morebtn");
      if (moreB) moreB.onclick = function(ev){
        ev.stopPropagation();
        if (document.getElementById("loommenu")) { closeMenu(); return; } // click again to close
        var r = moreB.getBoundingClientRect();
        var items = [
          { label: "MCP servers", icon: ICONS.plug, hint: "connect", run: function(){ toggleComposerPanel("mcp"); } },
          { label: "Skills", icon: ICONS.spark, hint: skillHint(), run: function(){ toggleComposerPanel("skills"); } },
          { sep: true },
          { head: "transcript" },
          { label: "Normal", icon: tview() === "normal" ? ICONS.check : "", hint: "what it said and did",
            run: function(){ setTView("normal"); } },
          { label: "Thinking", icon: tview() === "thinking" ? ICONS.check : "", hint: "+ reasoning",
            run: function(){ setTView("thinking"); } },
          { label: "Verbose", icon: tview() === "verbose" ? ICONS.check : "", hint: "+ raw payloads",
            run: function(){ setTView("verbose"); } },
          { sep: true },
          { label: "Rewind…", icon: ICONS.rewind, hint: "put the files back", run: function(){ view.openRewindMenu(); } },
          { sep: true },
          { label: "Prompts", icon: ICONS.clipboard, hint: KMOD + "⇧V", run: function(){ openPrompts(); } },
          { label: "Attach a file", icon: ICONS.plus, run: function(){ var a = document.getElementById("attach"); if (a) a.click(); } },
        ];
        // The menu opens upward from a button that sits at the bottom of the
        // window; openMenu flips it, so it is given the button's top edge.
        openMenu(Math.round(r.left), Math.round(r.top - 4), items);
      };
      setAuto(state.auto);
      view.setComposerMode(state.cmode || "chat");
      refreshSkillCount();

      // ---- hold-to-talk -----------------------------------------------------
      // Press and hold records; release sends the audio to the daemon, whose
      // CONFIGURED transcriber (LOOM_STT_CMD — no cloud, no keys) turns it into
      // text appended to the composer. You still read it and press send: voice
      // fills the box, it does not fire the prompt, because a misheard word in
      // a dispatched turn costs a whole turn to walk back.
      var micB = document.getElementById("micbtn");
      if (micB && navigator.mediaDevices && window.MediaRecorder) {
        var rec = null, chunks = [];
        var stopRec = function(){
          if (rec && rec.state !== "inactive") rec.stop();
          micB.classList.remove("active");
        };
        var startRec = function(ev){
          ev.preventDefault();
          if (rec && rec.state === "recording") return;
          navigator.mediaDevices.getUserMedia({ audio: true }).then(function(stream){
            chunks = [];
            rec = new MediaRecorder(stream);
            rec.ondataavailable = function(e){ if (e.data && e.data.size) chunks.push(e.data); };
            rec.onstop = function(){
              stream.getTracks().forEach(function(t){ t.stop(); });
              var blob = new Blob(chunks, { type: rec.mimeType || "audio/webm" });
              if (blob.size < 1000) return; // a tap, not speech
              fetch("/api/projects/" + view.pid + "/voice", {
                method: "POST",
                headers: { "Authorization": "Bearer " + state.token, "Content-Type": "application/octet-stream" },
                body: blob,
              }).then(function(r){ return r.json().then(function(j){ return { ok: r.ok, j: j }; }); })
                .then(function(x){
                  if (!x.ok) { toast(x.j.error || "transcription failed"); return; }
                  var box = document.getElementById("box");
                  if (box) {
                    box.value = (box.value ? box.value + " " : "") + x.j.text;
                    box.focus();
                  }
                }).catch(function(e){ toast(e.message); });
            };
            rec.start();
            micB.classList.add("active");
          }).catch(function(){ toast("microphone permission refused"); });
        };
        micB.onmousedown = startRec;
        micB.ontouchstart = startRec;
        micB.onmouseup = stopRec;
        micB.onmouseleave = stopRec;
        micB.ontouchend = stopRec;
      } else if (micB) {
        micB.style.display = "none"; // no recorder in this browser — no dead button
      }

      // Drag a file straight onto the card.
      var cbox = document.querySelector(".cbox");
      if (cbox) {
        cbox.addEventListener("dragover", function(e){ e.preventDefault(); });
        cbox.addEventListener("drop", function(e){
          e.preventDefault();
          Array.prototype.forEach.call((e.dataTransfer && e.dataTransfer.files) || [], uploadFile);
        });
      }
      updateModelLabel();
    }


    // The one selector that says who runs the turn: AUTO (the router) or a chosen
    // agent. In AUTO the model is the router's call, so the model pill steps aside.
    function updateModelLabel(){
      var lbl = document.getElementById("cmodellabel");
      var p = state.project || {};
      var cur = (p.agents || []).filter(function(a){ return a.id === state.selected; })[0];
      if (lbl) lbl.textContent = (cur && cur.model) ? cur.model : "model";
      var mp = document.getElementById("modelpick");
      if (mp) mp.style.display = state.auto || state.cmode === "orch" ? "none" : "";
      var chip = document.getElementById("cagent");
      if (!chip) return;
      // Always visible in Chat: hiding it is what made the agent unswitchable
      // before — you can't click a control that isn't painted. Orchestrate
      // has its own cast (drawOrchControls), so there it steps aside.
      chip.style.display = state.cmode === "orch" ? "none" : "";
      chip.classList.remove("dim");
      chip.classList.toggle("auto", state.auto);
      if (state.auto) {
        chip.innerHTML = '<span class="autodot"></span><span class="can">AUTO</span><span class="cchev">' + ICONS.chevron + "</span>";
      } else if (cur) {
        chip.innerHTML = agentGlyph(cur.kind, cur.id) + '<span class="can">' + esc(agentLabel(cur.kind, cur.id)) + "</span>" +
          (cur.busy ? '<span class="cadot" style="background:var(--live)" title="working"></span>' : "") +
          '<span class="cchev">' + ICONS.chevron + "</span>";
      } else {
        chip.innerHTML = '<span class="cadot"></span><span class="can">agent</span><span class="cchev">' + ICONS.chevron + "</span>";
      }
      drawPermChip(cur);
    }


    // ---- permissions -------------------------------------------------------
    /** The chip beside the agent picker: the chosen agent's mode, in its state colour. */
    function drawPermChip(cur){
      var pc = document.getElementById("cperm"); if (!pc) return;
      // Nothing to set for the router (AUTO picks per hop), a bridge (it runs
      // in its own window, under its own rules), or in Orchestrate, whose
      // cast wears its modes on the chips instead.
      if (!cur || state.auto || state.cmode === "orch" || cur.tier === "bridge") { pc.style.display = "none"; return; }
      var mode = permOf(cur), cell = permProfile(cur.kind).modes[mode] || {};
      pc.style.display = "";
      pc.className = "cperm " + mode;
      pc.setAttribute("data-mode", mode);
      pc.title = "permissions \u00b7 " + (cell.label || PERM_NAMES[mode]) + " \u2014 click to change";
      pc.setAttribute("aria-label", "permissions: " + (PERM_NAMES[mode] || mode));
      pc.innerHTML = ICONS.shield + '<span class="cpl">' + esc(PERM_SHORT[mode] || mode) + '</span><span class="cchev">' + ICONS.chevron + "</span>";
    }

    /**
     * Bypass / Auto / Always ask for one agent. Each row says what the mode
     * means on *this* CLI (they disagree), and a mode the real CLI couldn't
     * honour is shown, disabled, with what was observed — not hidden, so you
     * learn why it isn't there instead of assuming it is.
     */
    function openPermMenu(agentId){
      var p = state.project || {};
      var a = (p.agents || []).filter(function(x){ return x.id === agentId; })[0];
      var m = document.getElementById("cmenu");
      if (!m) return;
      if (!a) { toast("pick an agent first"); return; }
      view.menuState = { kind: "permmenu", at: 0, sel: 0, items: [], agent: agentId };
      function paint(){
        var prof = permProfile(a.kind), cur = permOf(a), lbl = agentLabel(a.kind, a.id);
        var askCell = prof.modes.ask || {};
        m.style.display = "block"; m.className = "cmenu";
        m.innerHTML = '<div class="cmhead">permissions \u00b7 ' + esc(lbl) + (a.id !== lbl ? " (" + esc(a.id) + ")" : "") + "</div>" +
          PERM_MODES.map(function(mode){
            var cell = prof.modes[mode] || {}, parts = permSplit(cell.label), off = !!cell.unsupported;
            return '<div class="cmi pm' + (off ? " off" : "") + '" data-pm="' + mode + '" role="menuitemradio" aria-checked="' + (mode === cur) + '"' +
              (off ? ' aria-disabled="true" title="' + esc(cell.unsupported) + '"' : "") + ">" +
              '<span class="ic"><span class="pmdot ' + mode + '"></span></span>' +
              '<span class="pmt"><b>' + esc(PERM_NAMES[mode]) + "</b>" +
                "<small>" + esc(off ? "Unavailable \u2014 " + cell.unsupported : (parts[1] || parts[0])) + "</small>" +
                (cell.flags && !off ? "<code>" + esc(cell.flags) + "</code>" : "") + "</span>" +
              (mode === cur ? '<span class="tick">' + ICONS.check + "</span>" : "") + "</div>";
          }).join("") +
          (askCell.ask === "approvals" ? '<div class="cmfoot">Always ask: each tool call waits in the thread for you to allow or deny.</div>'
            : askCell.ask === "read-only" ? '<div class="cmfoot">' + esc(lbl) + " can\u2019t hand a prompt to Loom, so \u201cask\u201d runs it read-only.</div>" : "");
        Array.prototype.forEach.call(m.querySelectorAll("[data-pm]"), function(row){
          row.onmousedown = function(ev){
            ev.preventDefault();
            if (row.classList.contains("off")) { toast(row.getAttribute("title") || "not available for this agent"); return; }
            var mode = row.getAttribute("data-pm");
            closeMenu();
            if (mode !== permOf(a)) setPermissions(a.id, mode);
          };
        });
      }
      paint();
      if (!state.permProfiles) loadPermProfiles().then(function(){ if (view.menuState && view.menuState.kind === "permmenu" && view.menuState.agent === agentId) paint(); });
      setTimeout(function(){ document.addEventListener("mousedown", menuAway); }, 0);
    }

    function setPermissions(agentId, mode){
      var a = ((state.project || {}).agents || []).filter(function(x){ return x.id === agentId; })[0];
      var was = a && a.permissions;
      if (a) a.permissions = mode; // paint it now; the POST confirms it or puts it back
      updateModelLabel(); view.drawOrchControls();
      api("/api/projects/" + view.pid + "/agents/" + encodeURIComponent(agentId) + "/permissions", {
        method: "POST", body: JSON.stringify({ permissions: mode }),
      }).then(function(){
        toast(labelOf(agentId) + " \u2192 " + PERM_NAMES[mode].toLowerCase());
        view.refresh();
      }).catch(function(err){
        if (a) a.permissions = was;
        updateModelLabel(); view.drawOrchControls();
        toast(err.message);
      });
    }


    // ---- plan mode -----------------------------------------------------------
    function setPlan(on){
      view.planState = !!on;
      try { if (view.planState) localStorage.setItem(view.PLAN_KEY, "1"); else localStorage.removeItem(view.PLAN_KEY); } catch (e) {}
      drawPlan();
    }

    /** The switch, the card's edge, the placeholder, the orchestra's send, the hint. */
    function drawPlan(){
      var b = document.getElementById("planbtn");
      if (b) { b.classList.toggle("on", view.planState); b.setAttribute("aria-checked", view.planState ? "true" : "false"); }
      var cb = document.querySelector(".cbox"); if (cb) cb.classList.toggle("planon", view.planState);
      var os = document.getElementById("orchsend");
      if (os) os.innerHTML = view.planState ? ICONS.plan + "Write plan" : ICONS.orchestra + "Orchestrate";
      var box = document.getElementById("box"); if (box) box.placeholder = composerPlaceholder();
      view.drawStatus();
    }

    function composerPlaceholder(){
      if (state.cmode === "orch") return view.planState
        ? "Describe the goal \u2014 the orchestrator writes PLAN.md and a spec per task, changing no code\u2026"
        : "Describe the goal \u2014 the orchestrator splits it into tasks and runs them in parallel\u2026";
      return view.planState ? "What should be planned? The agent writes it to plans/ and changes no code\u2026" : "Message\u2026  @ for files, / for actions";
    }

    function loadPrompts(){
      return api("/api/prompts").then(function(j){
        view.prompts.saved = j.saved || []; view.prompts.recent = j.recent || []; view.prompts.loaded = true;
        if (view.menuState && view.menuState.kind === "prompts") drawPrompts();
      }).catch(function(err){
        var l = document.getElementById("pmlist"); if (l) l.innerHTML = '<div class="pmempty">' + esc(err.message) + "</div>";
      });
    }

    function openPrompts(){
      if (view.menuState && view.menuState.kind === "prompts") { closeMenu(); var bx = document.getElementById("box"); if (bx) bx.focus(); return; }
      if (view.desktop && state.tab !== "thread") view.showTab("thread"); // the composer lives under Thread
      var m = document.getElementById("cmenu"); if (!m) return;
      closeMenu();
      view.menuState = { kind: "prompts", at: 0, sel: 0, items: [] };
      view.prompts.q = ""; view.prompts.sel = 0;
      m.className = "cmenu pmgr";
      m.style.display = "flex";
      m.innerHTML = '<div class="pmhead"><label class="pmq">' + ICONS.search +
          '<input id="pmq" placeholder="Search saved and recent prompts\u2026" autocomplete="off" spellcheck="false" aria-label="search prompts" aria-controls="pmlist"></label>' +
          '<button type="button" class="pmsave" id="pmsave" title="save what\u2019s in the composer">' + ICONS.bookmark + "Save current</button></div>" +
        '<div class="pmlist" id="pmlist" role="listbox" aria-label="prompts">' + (view.prompts.loaded ? "" : LOADER) + "</div>" +
        '<div class="pmfoot"><span><kbd>\u2191</kbd><kbd>\u2193</kbd> move</span><span><kbd>\u21b5</kbd> insert</span>' +
          "<span><kbd>" + KMOD + "\u21b5</kbd> insert &amp; send</span><span><kbd>esc</kbd> close</span></div>";
      var pb = document.getElementById("promptbtn"); if (pb) pb.classList.add("on");
      var q = document.getElementById("pmq");
      q.oninput = function(){ view.prompts.q = q.value; view.prompts.sel = 0; drawPrompts(); };
      q.onkeydown = promptKey;
      document.getElementById("pmsave").onclick = saveCurrentPrompt;
      if (view.prompts.loaded) drawPrompts();
      loadPrompts();
      setTimeout(function(){ document.addEventListener("mousedown", menuAway); }, 0);
      q.focus();
    }

    function promptRows(){
      var q = view.prompts.q.trim().toLowerCase();
      var hit = function(t){ return !q || String(t || "").toLowerCase().indexOf(q) >= 0; };
      var kept = {};
      view.prompts.saved.forEach(function(sp){ kept[sp.text] = 1; });
      var rows = [];
      view.prompts.saved.forEach(function(sp){ if (hit(sp.title) || hit(sp.text)) rows.push({ kind: "saved", p: sp }); });
      view.prompts.recent.forEach(function(r){ if (hit(r.text)) rows.push({ kind: "recent", p: r, kept: !!kept[r.text] }); });
      return rows;
    }

    function promptRow(r, i){
      var pr = r.p, text = String(pr.text || ""), lines = text.split("\n");
      var title = r.kind === "saved" ? (pr.title || lines[0]) : lines[0];
      // the snippet is whatever the title didn't already say
      var rest = title === lines[0] ? lines.slice(1).join(" ") : text;
      var snippet = rest.replace(/\s+/g, " ").trim();
      var pinned = r.kind === "saved" && pr.pinned;
      var meta = r.kind === "saved"
        ? (pr.uses ? "used " + pr.uses + "\u00d7" : "saved " + rel(pr.createdAt))
        : (pr.mode && pr.mode !== "chat" ? (pr.mode === "orchestrate" ? "orchestra" : pr.mode) + " \u00b7 " : "") + rel(pr.at);
      var acts = r.kind === "saved"
        ? '<button type="button" data-pma="pin" class="' + (pinned ? "on" : "") + '" title="' + (pinned ? "unpin" : "pin to the top") + '">' + ICONS.pin + "</button>" +
          '<button type="button" data-pma="del" class="del" title="delete">' + ICONS.trash + "</button>"
        : (r.kept ? '<button type="button" class="on" title="already saved" disabled>' + ICONS.check + "</button>"
          : '<button type="button" data-pma="save" title="save this prompt">' + ICONS.bookmark + "</button>");
      return '<div class="pmrow' + (i === view.prompts.sel ? " sel" : "") + (pinned ? " pinned" : "") + '" data-pr="' + i + '" role="option" aria-selected="' + (i === view.prompts.sel) + '">' +
        '<span class="pmi">' + (r.kind === "recent" ? ICONS.clock : pinned ? ICONS.pin : ICONS.bookmark) + "</span>" +
        '<span class="pmb"><div class="pmtt">' + esc(title || "(empty)") + "</div>" + (snippet ? '<div class="pmsn">' + esc(snippet.slice(0, 200)) + "</div>" : "") + "</span>" +
        '<span class="pmm">' + esc(meta) + "</span>" +
        '<span class="pmacts">' + acts + "</span></div>";
    }

    function drawPrompts(){
      var list = document.getElementById("pmlist"); if (!list) return;
      var rows = view.prompts.rows = promptRows();
      if (view.prompts.sel >= rows.length) view.prompts.sel = Math.max(0, rows.length - 1);
      var count = { pinned: 0, saved: 0, recent: 0 };
      rows.forEach(function(r){ count[r.kind === "recent" ? "recent" : r.p.pinned ? "pinned" : "saved"]++; });
      var NAMES = { pinned: "Pinned", saved: "Saved", recent: "Recent" };
      var html = "", last = "";
      rows.forEach(function(r, i){
        var sec = r.kind === "recent" ? "recent" : r.p.pinned ? "pinned" : "saved";
        if (sec !== last) {
          html += '<div class="pmsec">' + NAMES[sec] + ' <span class="bn">' + count[sec] + "</span>" +
            (sec === "recent" && !view.prompts.q ? '<button type="button" data-pmclear="1" title="forget every sent prompt">Clear</button>' : "") + "</div>";
          last = sec;
        }
        html += promptRow(r, i);
      });
      if (!rows.length) html = view.prompts.q
        ? '<div class="pmempty">Nothing matches \u201c' + esc(view.prompts.q) + "\u201d.</div>"
        : '<div class="pmempty"><b>No prompts yet.</b><br>Everything you send lands under Recent \u2014 save the ones worth keeping.</div>';
      list.innerHTML = html;
      Array.prototype.forEach.call(list.querySelectorAll("[data-pr]"), function(row){
        row.onmousedown = function(ev){
          ev.preventDefault(); // keep focus in the search box
          var i = Number(row.getAttribute("data-pr"));
          var act = ev.target.closest && ev.target.closest("[data-pma]");
          if (act) { promptAction(i, act.getAttribute("data-pma")); return; }
          if (ev.target.closest && ev.target.closest(".pmacts")) return;
          insertPrompt(i, ev.metaKey || ev.ctrlKey);
        };
      });
      var clr = list.querySelector("[data-pmclear]");
      if (clr) clr.onmousedown = function(ev){
        ev.preventDefault();
        if (!window.confirm("Forget every prompt you've sent? Saved prompts stay.")) return;
        api("/api/prompts/recent", { method: "DELETE" }).then(function(){ view.prompts.recent = []; drawPrompts(); }).catch(function(err){ toast(err.message); });
      };
      var sv = document.getElementById("pmsave"), bx = document.getElementById("box");
      if (sv) sv.disabled = !(bx && bx.value.trim());
      var sel = list.querySelector(".pmrow.sel");
      if (sel && sel.scrollIntoView) sel.scrollIntoView({ block: "nearest" });
    }

    function promptKey(e){
      var n = view.prompts.rows.length;
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        if (n) { view.prompts.sel = (view.prompts.sel + (e.key === "ArrowDown" ? 1 : -1) + n) % n; drawPrompts(); }
        return;
      }
      if (e.key === "Enter") { e.preventDefault(); insertPrompt(view.prompts.sel, e.metaKey || e.ctrlKey); return; }
      if (e.key === "Escape") { e.preventDefault(); closeMenu(); var bx = document.getElementById("box"); if (bx) bx.focus(); }
    }

    /** Put a prompt in the composer: into an empty box whole, else at the caret. */
    function insertPrompt(i, andSend){
      var r = view.prompts.rows[i]; if (!r) return;
      var box = document.getElementById("box"); if (!box) return;
      var text = String(r.p.text || "");
      closeMenu();
      var v = box.value;
      if (!v.trim()) { box.value = text; box.setSelectionRange(text.length, text.length); }
      else {
        var a = box.selectionStart, b = box.selectionEnd;
        var before = v.slice(0, a), after = v.slice(b);
        var pre = before && !/\s$/.test(before) ? " " : "";
        box.value = before + pre + text + after;
        var caret = (before + pre + text).length;
        box.setSelectionRange(caret, caret);
      }
      box.focus(); autosizeBox();
      if (r.kind === "saved") {
        r.p.uses = (r.p.uses || 0) + 1; // it floats up next time, as it will on the daemon
        api("/api/prompts/" + encodeURIComponent(r.p.id), { method: "PATCH", body: JSON.stringify({ used: true }) }).catch(function(){});
      }
      if (andSend) send();
    }

    function promptAction(i, act){
      var r = view.prompts.rows[i]; if (!r) return;
      var done = function(){ return loadPrompts(); };
      var fail = function(err){ toast(err.message); };
      if (act === "pin") {
        r.p.pinned = !r.p.pinned; drawPrompts();
        api("/api/prompts/" + encodeURIComponent(r.p.id), { method: "PATCH", body: JSON.stringify({ pinned: r.p.pinned }) }).then(done, fail);
      } else if (act === "del") {
        view.prompts.saved = view.prompts.saved.filter(function(sp){ return sp !== r.p; }); drawPrompts();
        api("/api/prompts/" + encodeURIComponent(r.p.id), { method: "DELETE" }).then(done, fail);
      } else if (act === "save") {
        api("/api/prompts", { method: "POST", body: JSON.stringify({ text: r.p.text }) })
          .then(function(j){ toast("saved \u201c" + view.trunc(j.prompt.title, 40) + "\u201d"); return done(); }, fail);
      }
    }

    function saveCurrentPrompt(){
      var box = document.getElementById("box"), t = box ? box.value.trim() : "";
      if (!t) { toast("type a prompt first, then save it"); return; }
      api("/api/prompts", { method: "POST", body: JSON.stringify({ text: t }) })
        .then(function(j){ toast("saved \u201c" + view.trunc(j.prompt.title, 40) + "\u201d"); view.prompts.q = ""; var q = document.getElementById("pmq"); if (q) q.value = ""; return loadPrompts(); })
        .catch(function(err){ toast(err.message); });
    }


    // AUTO ⇄ specific-agent: one selector, repainted to whichever is live.
    function setAuto(on){
      state.auto = !!on;
      updateModelLabel();
    }

    function refreshSkillCount(){
      api("/api/projects/" + view.pid + "/skills").then(function(r){
        var skills = r.skills || [], on = skills.filter(function(s){ return s.enabled; }).length;
        var b = document.getElementById("skcount"); if (b){ b.textContent = on; b.style.display = on ? "" : "none"; }
        state.skillsOn = on; state.skillsTotal = skills.length;
        // The button these marked is now a row inside the More menu; the
        // badge on More carries the same signal.
        var btn = document.getElementById("morebtn"); if (btn){ btn.classList.toggle("active", on > 0); }
      }).catch(function(){});
    }

    /**
     * Both of these open a modal, not a dropdown.
     *
     * A dropdown would be a 280px-tall scroll box that could only flip a switch
     * on a list you couldn't add to. Browsing a registry, reading what a server
     * does and pasting an endpoint is a task that deserves the screen.
     */
    function toggleComposerPanel(kind){
      closeComposerPanel();
      var p = state.project && state.project.id; if (!p) return;
      if (kind === "skills") openSkillsModal(p); else openMcpModal(p);
    }

    function closeComposerPanel(){ state.cpanel = null; var p = document.getElementById("cpanel"); if (p){ p.style.display = "none"; p.innerHTML = ""; } document.removeEventListener("mousedown", cpanelAway); }

    function cpanelAway(ev){ var p = document.getElementById("cpanel"); if (!p) return; if (p.contains(ev.target)) return; if (ev.target.closest && (ev.target.closest("#skillbtn") || ev.target.closest("#mcpbtn"))) return; closeComposerPanel(); }

    function mcpMark(slug, name){
      var d = view.MCPMARK[slug];
      if (d) return '<svg class="mcpmarksvg" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">' + d + "</svg>";
      return '<span class="mcpmono">' + esc((name || "?").slice(0, 1).toUpperCase()) + "</span>";
    }

    /**
     * The MCP marketplace — browse real servers and install one.
     *
     * A modal rather than the old dropdown because this is a task, not a
     * toggle: you search, read what a server does, decide, and sometimes have
     * to paste a URL. The list is the official registry
     * (registry.modelcontextprotocol.io), not a list typed into this file, so it
     * stays true as the ecosystem moves; the featured row is a curated set of
     * well-known providers for the empty state.
     */
    function openMcpModal(pid){
      if (document.querySelector(".scrim")) return;
      var scrim = document.createElement("div"); scrim.className = "scrim";
      scrim.innerHTML = '<div class="modal mcpmodal"><div class="modalhead">MCP servers' +
        '<button class="iconbtn" id="mcx" aria-label="close">' + ICONS.x + "</button></div>" +
        '<div class="mcpsearchwrap"><input id="mcpq" class="mcpsearch" type="search" placeholder="Search the MCP registry\u2026" autocomplete="off"/></div>' +
        '<div class="modalbody" id="mcpbody"><div class="loader"><i></i><i></i><i></i><i></i></div></div></div>';
      document.body.appendChild(scrim);
      function close(){ scrim.remove(); document.removeEventListener("keydown", onKey); }
      function onKey(e){ if (e.key === "Escape") close(); }
      document.addEventListener("keydown", onKey);
      scrim.addEventListener("click", function(ev){ if (ev.target === scrim) close(); });
      document.getElementById("mcx").onclick = close;

      var installed = {};
      function load(q){
        var body = document.getElementById("mcpbody"); if (!body) return;
        Promise.all([
          api("/api/mcp/catalog" + (q ? "?q=" + encodeURIComponent(q) : "")).catch(function(){ return { servers: [], featured: [], degraded: true }; }),
          api("/api/projects/" + pid + "/mcps").catch(function(){ return { mcps: [] }; })
        ]).then(function(res){
          var cat = res[0] || {}, mine = (res[1] && res[1].mcps) || [];
          installed = {}; mine.forEach(function(m){ installed[m.name] = m; });
          var list = (q ? (cat.servers || []) : (cat.featured || []).concat(cat.servers || []));
          renderMcpList(body, list, mine, cat.degraded, q);
        });
      }
      function renderMcpList(body, list, mine, degraded, q){
        // What's already connected comes first: this modal is also where you
        // check on and remove what you installed, not only where you add.
        var connectedRows = mine.filter(function(m){ return m.url || m.command; }).map(function(m){
          var ok = !!m.connected;
          return '<div class="mcpitem installed"><span class="mcpmark ' + (ok ? "on" : "off") + '">' + mcpMark(m.slug || String(m.name || "").toLowerCase(), m.name) + "</span>" +
            '<div class="mcpinfo"><div class="mcpname">' + esc(m.name) +
              '<span class="mcpstate ' + (ok ? "ok" : "bad") + '">' + (ok ? "reachable" : "unreachable") + "</span></div>" +
              '<div class="mcpdesc">' + esc(m.url || m.command || "") + "</div></div>" +
            '<button class="mcpbtn remove" data-remove="' + esc(m.name) + '">Remove</button></div>';
        }).join("");
        var rows = list.filter(function(s){ return !installed[s.name || s.title]; }).map(function(s){
          var key = s.name || s.title;
          var dest = s.url || (s.command ? s.command + " " + ((s.args || []).join(" ")) : "");
          return '<div class="mcpitem"><span class="mcpmark">' + mcpMark(s.slug, s.title || s.name) + "</span>" +
            '<div class="mcpinfo"><div class="mcpname">' + esc(s.title || s.name) +
              (s.transport ? '<span class="mcptr">' + esc(s.transport) + "</span>" : "") + "</div>" +
              '<div class="mcpdesc">' + esc(s.description || dest || "") + "</div></div>" +
            '<button class="mcpbtn" data-install="' + esc(encodeURIComponent(JSON.stringify(s))) + '">' + (s.needsUrl ? "Add\u2026" : "Install") + "</button></div>";
        }).join("");
        body.innerHTML =
          (degraded ? '<div class="mcpwarn">' + ICONS.route + " The public registry didn\u2019t answer \u2014 showing well-known providers only. Search needs the registry.</div>" : "") +
          (connectedRows ? '<div class="mcpsec">Installed in this project</div>' + connectedRows : "") +
          '<div class="mcpsec">' + (q ? "Registry results" : "Popular providers") + "</div>" +
          (rows || '<div class="mcpempty">Nothing matched \u201c' + esc(q || "") + '\u201d.</div>') +
          '<div class="mcpcustom"><div class="mcpsec">Add one by hand</div>' +
            '<div class="mcprow2"><input id="mcpcn" class="mcpin" placeholder="Name"/><input id="mcpcu" class="mcpin wide" placeholder="https://\u2026/mcp or a command"/>' +
            '<button class="mcpbtn" id="mcpcadd">Add</button></div></div>';
        Array.prototype.forEach.call(body.querySelectorAll("[data-install]"), function(b){
          b.onclick = function(){
            var s = JSON.parse(decodeURIComponent(b.getAttribute("data-install")));
            var url = s.url;
            if (s.needsUrl || (!s.url && !s.command)){
              // Some providers can't be shipped with a fixed endpoint — a hosted
              // one typically embeds your account or region in the hostname. The
              // catalog hands over a template rather than guessing a URL that
              // would simply fail, so prefill it and let the person finish it.
              var hint = (s.requires ? s.requires + "\n\n" : "") + "Endpoint URL for " + (s.title || s.name) + ":";
              url = window.prompt(hint, s.urlTemplate || "https://");
              if (!url || url === s.urlTemplate) return;
            }
            doInstall({ name: s.title || s.name, slug: s.slug, url: url, command: s.command, args: s.args, transport: s.transport, description: s.description }, b);
          };
        });
        Array.prototype.forEach.call(body.querySelectorAll("[data-remove]"), function(b){
          b.onclick = function(){
            b.disabled = true; b.textContent = "\u2026";
            api("/api/projects/" + pid + "/mcps/" + encodeURIComponent(b.getAttribute("data-remove")), { method: "DELETE" })
              .then(function(){ load(document.getElementById("mcpq").value.trim()); })
              .catch(function(err){ toast(err.message); b.disabled = false; b.textContent = "Remove"; });
          };
        });
        var addBtn = body.querySelector("#mcpcadd");
        if (addBtn) addBtn.onclick = function(){
          var n = body.querySelector("#mcpcn").value.trim(), u = body.querySelector("#mcpcu").value.trim();
          if (!n || !u) return void toast("Name and endpoint are both required.");
          var isUrl = /^https?:\/\//.test(u);
          doInstall(isUrl ? { name: n, url: u, transport: "http" } : { name: n, command: u.split(/\s+/)[0], args: u.split(/\s+/).slice(1), transport: "stdio" }, addBtn);
        };
      }
      function doInstall(payload, btn){
        var old = btn.textContent; btn.disabled = true; btn.textContent = "Installing\u2026";
        api("/api/projects/" + pid + "/mcps/install", { method: "POST", body: JSON.stringify(payload) })
          .then(function(){ toast(payload.name + " installed"); load(document.getElementById("mcpq").value.trim()); })
          .catch(function(err){ toast(err.message || "install failed"); btn.disabled = false; btn.textContent = old; });
      }
      var qEl = document.getElementById("mcpq"), qT = null;
      qEl.oninput = function(){ if (qT) clearTimeout(qT); qT = setTimeout(function(){ load(qEl.value.trim()); }, 280); };
      qEl.focus();
      load("");
    }

    /**
     * The Skills modal — everything installable on this machine, and a way to
     * bring in more.
     *
     * Skills used to be a toggle list over two directories, so the dozens a
     * person already has under ~/.claude/skills were invisible and there was no
     * way to add one. This browses every real root (project, user, plugins) and
     * installs from a git URL or a folder.
     */
    function openSkillsModal(pid){
      if (document.querySelector(".scrim")) return;
      var scrim = document.createElement("div"); scrim.className = "scrim";
      scrim.innerHTML = '<div class="modal mcpmodal"><div class="modalhead">Skills' +
        '<button class="iconbtn" id="skx" aria-label="close">' + ICONS.x + "</button></div>" +
        '<div class="mcpsearchwrap"><input id="skq" class="mcpsearch" type="search" placeholder="Filter skills\u2026" autocomplete="off"/></div>' +
        '<div class="modalbody" id="skbody"><div class="loader"><i></i><i></i><i></i><i></i></div></div></div>';
      document.body.appendChild(scrim);
      function close(){ scrim.remove(); document.removeEventListener("keydown", onKey); if (state.refreshComposer) state.refreshComposer(); }
      function onKey(e){ if (e.key === "Escape") close(); }
      document.addEventListener("keydown", onKey);
      scrim.addEventListener("click", function(ev){ if (ev.target === scrim) close(); });
      document.getElementById("skx").onclick = close;

      var all = [];
      function load(){
        var body = document.getElementById("skbody"); if (!body) return;
        api("/api/projects/" + pid + "/skills/catalog")
          .catch(function(){ return api("/api/projects/" + pid + "/skills"); })
          .then(function(r){ all = r.skills || []; draw(); })
          .catch(function(){ body.innerHTML = '<div class="mcpempty">Skills unavailable \u2014 the daemon didn\u2019t answer.</div>'; });
      }
      function draw(){
        var body = document.getElementById("skbody"); if (!body) return;
        var q = (document.getElementById("skq").value || "").trim().toLowerCase();
        var list = all.filter(function(s){
          return !q || (s.id + " " + (s.name || "") + " " + (s.description || "")).toLowerCase().indexOf(q) >= 0;
        });
        var ORIGINS = { project: "in this project", user: "your skills", plugin: "from a plugin", bundled: "bundled" };
        var groups = {};
        list.forEach(function(s){ var o = s.origin || "bundled"; (groups[o] = groups[o] || []).push(s); });
        var html = "";
        ["project", "user", "plugin", "bundled"].forEach(function(o){
          var g = groups[o]; if (!g || !g.length) return;
          html += '<div class="mcpsec">' + esc(ORIGINS[o] || o) + " \u00b7 " + g.length + "</div>" +
            g.map(function(s){
              return '<div class="mcpitem"><span class="mcpmark ' + (s.enabled ? "on" : "") + '">' + mcpMark("", s.name || s.id) + "</span>" +
                '<div class="mcpinfo"><div class="mcpname">' + esc(s.name || s.id) +
                  (s.enabled ? '<span class="mcpstate ok">on</span>' : "") + "</div>" +
                  '<div class="mcpdesc">' + esc(s.description || "") + "</div></div>" +
                '<button class="mcpbtn' + (s.enabled ? " remove" : "") + '" data-tog="' + esc(s.id) + '" data-on="' + (s.enabled ? "1" : "0") + '">' +
                  (s.enabled ? "Disable" : "Enable") + "</button></div>";
            }).join("");
        });
        body.innerHTML = (html || '<div class="mcpempty">No skills matched.</div>') +
          '<div class="mcpcustom"><div class="mcpsec">Install a skill</div>' +
          '<div class="mcprow2"><input id="skgit" class="mcpin wide" placeholder="https://github.com/\u2026 (git) or /path/to/skill"/>' +
          '<button class="mcpbtn" id="skadd">Install</button></div>' +
          '<div class="mcphint">Needs a <code>SKILL.md</code> at the root. It is copied into this project\u2019s <code>skills/</code>.</div></div>';
        Array.prototype.forEach.call(body.querySelectorAll("[data-tog]"), function(b){
          b.onclick = function(){
            var on = b.getAttribute("data-on") === "1";
            b.disabled = true;
            api("/api/projects/" + pid + "/skills/" + encodeURIComponent(b.getAttribute("data-tog")),
              { method: "PUT", body: JSON.stringify({ enabled: !on }) })
              .then(load).catch(function(err){ toast(err.message); b.disabled = false; });
          };
        });
        body.querySelector("#skadd").onclick = function(){
          var v = (body.querySelector("#skgit").value || "").trim();
          if (!v) return void toast("Paste a git URL or a folder path.");
          var btn = this; btn.disabled = true; btn.textContent = "Installing\u2026";
          var payload = /^(https?:|git@|ssh:)/.test(v) ? { gitUrl: v } : { dir: v };
          api("/api/projects/" + pid + "/skills/install", { method: "POST", body: JSON.stringify(payload) })
            .then(function(r){ toast("Installed " + ((r && r.installed && r.installed.id) || "skill")); load(); })
            .catch(function(err){ toast(err.message || "install failed"); })
            .then(function(){ btn.disabled = false; btn.textContent = "Install"; });
        };
      }
      document.getElementById("skq").oninput = draw;
      load();
    }

    function scheduleSkillSuggest(text){ if (view._sugT) clearTimeout(view._sugT); view._sugT = setTimeout(function(){ doSkillSuggest(text); }, 300); }

    function doSkillSuggest(text){
      var bar = document.getElementById("cskillsug"); if (!bar) return;
      if (!text || text.trim().length < 4){ bar.style.display = "none"; return; }
      api("/api/projects/" + view.pid + "/skills?suggest=" + encodeURIComponent(text.slice(0, 200))).then(function(r){
        var s = r.suggestion;
        if (!s){ bar.style.display = "none"; return; }
        bar.style.display = "";
        bar.innerHTML = '<span class="sugico">' + ICONS.spark + '</span><span class="sugtx"><b>Skill: ' + esc(s.name || s.id) + '</b> <span class="obsub">' + esc((s.description || "").slice(0, 90)) + '</span></span><button class="sugadd" data-skill="' + esc(s.id) + '">+ Enable</button><button class="sugx iconbtn" aria-label="dismiss">' + ICONS.x + "</button>";
        var add = bar.querySelector(".sugadd");
        if (add) add.onclick = function(){ api("/api/projects/" + view.pid + "/skills/" + encodeURIComponent(s.id), { method: "PUT", body: JSON.stringify({ enabled: true }) }).then(function(){ refreshSkillCount(); bar.style.display = "none"; toast("enabled " + (s.name || s.id)); }); };
        var x = bar.querySelector(".sugx"); if (x) x.onclick = function(){ bar.style.display = "none"; };
      }).catch(function(){});
    }
return { autosizeBox, drawAttach, closeMenu, menuAway, openModelMenu, bindComposer, updateModelLabel, openPermMenu, composerPlaceholder };
}
