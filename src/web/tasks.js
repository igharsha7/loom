/** Browser tasks module. See README.md for ownership and startup. */
import { brandMark } from './agents.js';
import { api } from './connection.js';
import { esc } from './format.js';
import { ICONS } from './icons.js';
import { toast } from './notifications.js';
import { state } from './state.js';


  // ---- New Task modal (Orca's Create Worktree, mapped to Loom) -------------
  // One ADE runs it directly; several run it as a pipeline, hop to hop.
  function openTaskModal(prefillPid, prefillAgents, prefillText){
    var projects = state.projects || [];
    if (!projects.length) { toast("add a project first"); return; }
    if (document.querySelector(".scrim")) return;
    var pid = prefillPid || state.pid || projects[0].id;
    var picked = (prefillAgents || []).slice();
    function proj(id){ for (var i = 0; i < projects.length; i++) if (projects[i].id === id) return projects[i]; return null; }
    function agentsFor(id){ var p = proj(id); return p ? p.agents.filter(function(a){ return a.tier === "adapter"; }) : []; }
    function routesFor(id){ var p = proj(id); return (p && p.routeNames) || ["auto"]; }
    function projOpts(){ return projects.map(function(p){ return '<option value="' + esc(p.id) + '"' + (p.id === pid ? " selected" : "") + ">" + esc(p.name) + "</option>"; }).join(""); }
    function routeOpts(id){ return '<option value="">\u2014 use the agents above \u2014</option>' + routesFor(id).map(function(n){ return '<option value="' + esc(n) + '">' + esc(n === "auto" ? "auto \u2014 LLM picks each hop" : n) + "</option>"; }).join(""); }
    var scrim = document.createElement("div");
    scrim.className = "scrim";
    scrim.innerHTML = '<div class="modal">' +
      '<div class="modalhead">Create task<button class="iconbtn" id="mclose">' + ICONS.x + "</button></div>" +
      '<div class="modalbody">' +
        '<div class="field"><label>Project</label><select id="mproj">' + projOpts() + "</select></div>" +
        '<div class="field"><label>Task</label><textarea id="mtask" placeholder="what should the agent do?"></textarea></div>' +
        '<div class="field"><label>Agents \u00b7 one, or several in sequence</label>' +
          '<div class="agsel" id="magsel"></div>' +
          '<div class="rolelist" id="magroles"></div>' +
          '<span class="hintx" id="maghint"></span></div>' +
        '<div class="disclose" id="madv">\u25b8 Advanced</div>' +
        '<div class="field" id="mroutewrap" style="display:none"><label>Named pipeline</label>' +
          '<select id="mroute">' + routeOpts(pid) + "</select>" +
          '<span class="hintx">run one of the project\u2019s saved pipelines instead of the agents above.</span></div>' +
      "</div>" +
      '<div class="modalfoot"><button class="btn ghost" id="mcancel">Cancel</button>' +
      '<button class="btn primary" id="mcreate">Create task<span class="kbd">\u2318\u21b5</span></button></div>' +
    "</div>";
    document.body.appendChild(scrim);
    function close(){ scrim.remove(); document.removeEventListener("keydown", onKey); }
    scrim.addEventListener("click", function(ev){ if (ev.target === scrim) close(); });
    document.getElementById("mclose").onclick = close;
    document.getElementById("mcancel").onclick = close;
    // The job each picked agent does THIS task — keyed by agent id, seeded from
    // the agent's own role but freely overridable here without changing it.
    var taskRoles = {};
    function drawChips(){
      var box = document.getElementById("magsel"); if (!box) return;
      var agents = agentsFor(pid);
      picked = picked.filter(function(id){ return agents.some(function(a){ return a.id === id; }); });
      box.innerHTML = agents.map(function(a){
        var order = picked.indexOf(a.id);
        return '<button type="button" class="agchip' + (order >= 0 ? " sel" : "") + '" data-id="' + esc(a.id) + '">' +
          '<span class="num">' + (order >= 0 ? order + 1 : "") + "</span>" +
          brandMark(a.kind) + esc(a.id) +
          '<span class="role">' + esc(a.role) + "</span></button>";
      }).join("") || '<span class="hintx">no agents configured for this project</span>';
      Array.prototype.forEach.call(box.querySelectorAll(".agchip"), function(ch){
        ch.onclick = function(){
          var id = ch.getAttribute("data-id");
          var i = picked.indexOf(id);
          if (i >= 0) picked.splice(i, 1); else picked.push(id);
          drawChips();
        };
      });
      drawRoles();
      var hint = document.getElementById("maghint");
      if (hint) hint.textContent = picked.length > 1
        ? "runs as a pipeline: " + picked.join(" \u2192 ")
        : picked.length === 1
          ? "one ADE runs the whole task"
          : "pick one ADE \u2014 or several to run them in order";
    }
    // The roles you can hand out. Only the first three carry distinct prompt
    // behaviour today (plan / execute / review); the rest are honest labels the
    // agent still gets told to act on.
    var TASK_ROLES = ["planner","executor","reviewer","general","researcher","tester","architect","documenter"];
    function drawRoles(){
      var wrap = document.getElementById("magroles"); if (!wrap) return;
      if (!picked.length) { wrap.innerHTML = ""; wrap.style.display = "none"; return; }
      wrap.style.display = "flex";
      var agents = agentsFor(pid);
      wrap.innerHTML = picked.map(function(id, i){
        var a = agents.filter(function(x){ return x.id === id; })[0] || {};
        var role = taskRoles[id] || a.role || "general";
        // ensure whatever the agent's own role is can still be selected
        var opts = TASK_ROLES.slice();
        if (opts.indexOf(role) < 0) opts.unshift(role);
        return '<div class="rolerow">' +
          '<span class="rn">' + (i + 1) + "</span>" + brandMark(a.kind) +
          '<span class="rid">' + esc(id) + "</span>" +
          '<select class="roleselect" data-roleid="' + esc(id) + '">' +
          opts.map(function(r){ return '<option value="' + esc(r) + '"' + (r === role ? " selected" : "") + ">" + esc(r) + "</option>"; }).join("") +
          "</select></div>";
      }).join("");
      Array.prototype.forEach.call(wrap.querySelectorAll(".roleselect"), function(sel){
        sel.onchange = function(){ taskRoles[sel.getAttribute("data-roleid")] = sel.value; };
      });
    }
    var advOpen = false;
    document.getElementById("madv").onclick = function(){
      advOpen = !advOpen;
      this.textContent = (advOpen ? "\u25be" : "\u25b8") + " Advanced";
      document.getElementById("mroutewrap").style.display = advOpen ? "" : "none";
    };
    document.getElementById("mproj").onchange = function(){
      pid = this.value;
      picked = [];
      drawChips();
      document.getElementById("mroute").innerHTML = routeOpts(pid);
    };
    // default-pick the current holder when nothing was prefilled
    if (!picked.length) {
      var holder = (proj(pid) || {}).holder;
      if (holder && agentsFor(pid).some(function(a){ return a.id === holder; })) picked = [holder];
    }
    drawChips();
    setTimeout(function(){
      var ta = document.getElementById("mtask"); if (!ta) return;
      if (prefillText) {
        ta.value = prefillText;
        // land the caret at the end so a Start-ed issue reads as a draft to
        // extend, not a field to overwrite
        ta.focus();
        ta.setSelectionRange(ta.value.length, ta.value.length);
      } else ta.focus();
    }, 30);
    function create(){
      var mproj = document.getElementById("mproj").value;
      var task = (document.getElementById("mtask").value || "").trim();
      var pipeline = document.getElementById("mroute").value;
      if (!task) return toast("describe the task first");
      if (!pipeline && !picked.length) return toast("pick at least one agent");
      var btn = document.getElementById("mcreate"); btn.disabled = true;
      var work, note;
      // The spec carries each step's assigned role, so a route can say "this one
      // plans, that one executes" without touching either agent's own role.
      var specWithRoles = picked.map(function(id){
        var r = taskRoles[id];
        return r ? { step: id, role: r } : { step: id };
      });
      var rolesNote = picked.map(function(id){ return id + (taskRoles[id] ? " (" + taskRoles[id] + ")" : ""); });
      if (pipeline) {
        work = api("/api/projects/" + mproj + "/route", { method: "POST", body: JSON.stringify({ task: task, spec: pipeline }) });
        note = "pipeline " + pipeline + " started";
      } else if (picked.length > 1) {
        work = api("/api/projects/" + mproj + "/route", { method: "POST", body: JSON.stringify({ task: task, spec: specWithRoles }) });
        note = picked.length + " agents \u00b7 " + rolesNote.join(" \u2192 ");
      } else if (taskRoles[picked[0]]) {
        // A single agent with an explicit role runs as a one-step route, so the
        // role's instruction is actually injected into its turn.
        work = api("/api/projects/" + mproj + "/route", { method: "POST", body: JSON.stringify({ task: task, spec: specWithRoles }) });
        note = "task sent to " + picked[0] + " as " + taskRoles[picked[0]];
      } else {
        var agent = picked[0];
        var holder = (proj(mproj) || {}).holder;
        var chain = agent !== holder
          ? api("/api/projects/" + mproj + "/handoff", { method: "POST", body: JSON.stringify({ to: agent }) })
          : Promise.resolve();
        work = chain.then(function(){
          // a new task starts in the project's main chat, not in whichever
          // conversation happened to be open when you hit N
          return api("/api/projects/" + mproj + "/messages", { method: "POST",
            body: JSON.stringify({ text: task, agentId: agent, chat: "main" }) });
        });
        note = "task sent to " + agent;
      }
      work.then(function(){
        close();
        toast(note);
        if (state.selectProject) state.selectProject(mproj);
        else location.hash = "#p/" + mproj;
      }).catch(function(err){ btn.disabled = false; toast(err.message); });
    }
    document.getElementById("mcreate").onclick = create;
    function onKey(e){
      if (e.key === "Escape") { e.preventDefault(); close(); }
      else if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); create(); }
    }
    document.addEventListener("keydown", onKey);
  }


  /**
   * A card of your own on the board. Same chrome as Create task, but this
   * writes a card rather than starting a run — so it also offers to do both:
   * "Create & start" hands the text to the agent and drops the card in
   * Working, which is where that work actually is.
   */
  function openBoardTaskModal(pid, column, onDone){
    if (document.querySelector(".scrim")) return;
    var p = state.project;
    var adapters = (p && p.agents ? p.agents : []).filter(function(a){ return a.tier === "adapter"; });
    var picked = null;
    var cols = [["working", "Working"], ["needs-you", "Needs you"],
                ["in-review", "In review"], ["ready", "Ready to merge"]];
    var scrim = document.createElement("div");
    scrim.className = "scrim";
    scrim.innerHTML = '<div class="modal">' +
      '<div class="modalhead">New card<button class="iconbtn" id="bmclose" aria-label="close">' + ICONS.x + "</button></div>" +
      '<div class="modalbody">' +
        '<div class="field"><label>Task</label>' +
          '<textarea id="bmtitle" placeholder="what needs doing?"></textarea></div>' +
        '<div class="field"><label>Column</label><select id="bmcol">' +
          cols.map(function(c){
            return '<option value="' + c[0] + '"' + (c[0] === column ? " selected" : "") + ">" + c[1] + "</option>";
          }).join("") + "</select></div>" +
        '<div class="field"><label>For <span class="opt">optional</span></label>' +
          '<div class="agsel" id="bmagsel"></div>' +
          '<span class="hintx" id="bmhint">just a note to yourself unless you pick someone</span></div>' +
      "</div>" +
      '<div class="modalfoot"><button class="btn ghost" id="bmcancel">Cancel</button>' +
        '<button class="btn outline" id="bmstart" style="display:none">Create &amp; start</button>' +
        '<button class="btn primary" id="bmcreate">Create card<span class="kbd">\u2318\u21b5</span></button></div>' +
    "</div>";
    document.body.appendChild(scrim);
    function close(){ scrim.remove(); document.removeEventListener("keydown", onKey); }
    scrim.addEventListener("click", function(ev){ if (ev.target === scrim) close(); });
    document.getElementById("bmclose").onclick = close;
    document.getElementById("bmcancel").onclick = close;

    function drawChips(){
      var box = document.getElementById("bmagsel"); if (!box) return;
      box.innerHTML = adapters.length
        ? adapters.map(function(a){
            return '<button type="button" class="agchip' + (picked === a.id ? " sel" : "") + '" data-id="' + esc(a.id) + '">' +
              brandMark(a.kind) + esc(a.id) + '<span class="role">' + esc(a.role || "") + "</span></button>";
          }).join("")
        : '<span class="hintx">no agents configured for this project</span>';
      Array.prototype.forEach.call(box.querySelectorAll(".agchip"), function(ch){
        ch.onclick = function(){
          var id = ch.getAttribute("data-id");
          picked = picked === id ? null : id; // click again to unassign
          drawChips();
        };
      });
      var hint = document.getElementById("bmhint");
      if (hint) hint.textContent = picked
        ? "the card is for " + picked + " \u2014 Create & start also sends it the task now"
        : "just a note to yourself unless you pick someone";
      var sb = document.getElementById("bmstart");
      if (sb) sb.style.display = picked ? "" : "none";
    }
    drawChips();
    setTimeout(function(){ var t = document.getElementById("bmtitle"); if (t) t.focus(); }, 30);

    function create(alsoStart){
      var title = (document.getElementById("bmtitle").value || "").trim();
      if (!title) return toast("what needs doing?");
      var col = document.getElementById("bmcol").value;
      // starting it means an agent is on it now, so the card belongs in Working
      var body = { title: title, column: alsoStart ? "working" : col };
      if (picked) body.agent = picked;
      document.getElementById("bmcreate").disabled = true;
      api("/api/projects/" + pid + "/board/tasks", { method: "POST", body: JSON.stringify(body) })
        .then(function(){
          if (!alsoStart) { close(); toast("card added"); if (onDone) onDone(); return; }
          var holder = (state.project || {}).holder;
          var chain = picked !== holder
            ? api("/api/projects/" + pid + "/handoff", { method: "POST", body: JSON.stringify({ to: picked }) })
            : Promise.resolve();
          return chain
            .then(function(){
              return api("/api/projects/" + pid + "/messages", {
                method: "POST",
                body: JSON.stringify({ text: title, agentId: picked, chat: "main" }),
              });
            })
            .then(function(){ close(); toast("sent to " + picked); if (onDone) onDone(); });
        })
        .catch(function(err){
          document.getElementById("bmcreate").disabled = false;
          toast(err.message);
        });
    }
    document.getElementById("bmcreate").onclick = function(){ create(false); };
    document.getElementById("bmstart").onclick = function(){ create(true); };
    function onKey(e){
      if (e.key === "Escape") { e.preventDefault(); close(); }
      else if ((e.metaKey || e.ctrlKey) && e.key === "Enter") { e.preventDefault(); create(false); }
    }
    document.addEventListener("keydown", onKey);
  }
export { openBoardTaskModal,openTaskModal };
