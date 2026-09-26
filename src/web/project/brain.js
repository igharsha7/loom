import { brandMark,kindOf } from '../agents.js';
import { api } from '../connection.js';
import { esc,rel } from '../format.js';
import { ICONS,LOADER } from '../icons.js';
import { toast } from '../notifications.js';
import { openSettingsModal } from '../settings.js';
import { teamShareHtml,wireTeamShare } from '../team.js';

/** brain behavior for one mounted project.
 * view contains live accessors to the owning project view's state and callbacks.
 * Creating this module only binds functions; startup and cleanup belong to project.js.
 */
export function createBrain(view) {


    function refreshBrain(){
      if (view.brainView === "team") return refreshTeamBrain();
      var el = document.getElementById("pane-brain"); if (!el) return;
      if (!el.querySelector(".brain")) el.innerHTML = '<div class="pane-inner">' + LOADER + "</div>";
      // Two reads: the learned memory units (the star), and the imported ADE
      // sources (context — what Loom pulled in from CLAUDE.md and friends).
      Promise.all([
        api("/api/projects/" + view.pid + "/brain?limit=200"),
        api("/api/projects/" + view.pid + "/memory").catch(function(){ return { memory: {} }; }),
      ]).then(function(r){
        el = document.getElementById("pane-brain"); if (!el || view.brainView !== "mine") return;
        var memories = (r[0] && r[0].memories) || [];
        var stats = (r[0] && r[0].stats) || { total: 0, byKind: {} };
        var m = (r[1] && r[1].memory) || {};
        var sources = m.sources || [];

        // Filter chips — All, then each kind that has memories, with its count.
        var chips = '<button class="bkind' + (view.brainKind === "" ? " on" : "") + '" data-kind="">All <span class="kn">' + (stats.total || 0) + "</span></button>";
        view.BRAIN_KINDS.forEach(function(k){
          var n = (stats.byKind && stats.byKind[k]) || 0;
          if (!n && view.brainKind !== k) return; // hide empty kinds unless selected
          chips += '<button class="bkind bk-' + k + (view.brainKind === k ? " on" : "") + '" data-kind="' + k + '">' + k + ' <span class="kn">' + n + "</span></button>";
        });
        var head = '<div class="bhead">' + brainSwitchHtml() + '<div class="bkinds">' + chips + "</div></div>";

        // The memory list — the learned units. This is what phase 2 fills.
        var shown = view.brainKind ? memories.filter(function(x){ return x.kind === view.brainKind; }) : memories;
        var list;
        if (!shown.length) {
          list = '<div class="bempty">' + (memories.length
            ? "No " + esc(view.brainKind) + " memories yet."
            : "Nothing learned yet. As agents finish turns, Loom reads each one and records what's worth keeping — constraints, decisions, and the failures worth not repeating. Add a decision below to seed it, or let an agent take a turn.") + "</div>";
        } else {
          list = '<div class="bmems">' + shown.map(function(x){
            var ents = (x.entities || []).slice(0, 6).map(function(e){ return '<span class="bent">' + esc(e) + "</span>"; }).join("");
            var conf = Math.round((x.confidence == null ? 1 : x.confidence) * 100);
            var who = (x.provenance && x.provenance.agentId) || "user";
            var when = x.updatedAt ? rel(x.updatedAt) : "";
            var low = conf < 60;
            return '<div class="bmem' + (low ? " low" : "") + '" data-mid="' + esc(x.id) + '">' +
              '<div class="bmrow"><span class="bbadge bk-' + esc(x.kind) + '">' + esc(x.kind) + "</span>" +
              '<span class="bmtext">' + esc(x.text) + "</span>" +
              '<button class="bforget iconbtn xs" data-forget="' + esc(x.id) + '" title="forget this" aria-label="forget this memory">' + ICONS.x + "</button></div>" +
              (ents ? '<div class="bents">' + ents + "</div>" : "") +
              '<div class="bmmeta">' + brandMark(kindOf(who)) + esc(who) +
              (when ? ' <span class="dim">\u00b7 ' + esc(when) + "</span>" : "") +
              (low ? ' <span class="dim">\u00b7 ' + conf + '% \u2014 shown, not injected</span>' : "") +
              "</div></div>";
          }).join("") + "</div>";
        }

        // Seed box — a decision you type. It dual-writes into the brain, so it's
        // the manual counterpart to what the extractor does automatically.
        var seed = '<form class="bseed" id="decform">' +
          '<input id="decbox" placeholder="Record a decision or fact this project has made\u2026" autocomplete="off">' +
          '<button class="btn primary sm" type="submit">Add</button></form>';

        // Imported ADE memory — secondary, folded under a quiet header.
        var src = '<div class="bsec">Imported from your agents<span class="bhint">their own memory files</span>' +
          '<button class="lnk" id="reimport" style="margin-left:auto">re-import</button></div>';
        src += sources.length
          ? '<div class="bsrcs">' + sources.map(function(s){
              return '<div class="bsrc">' + brandMark(s.kind) +
                '<span class="si">' + esc(s.agentId) + "</span>" +
                '<span class="sf mono">' + esc(s.file) + "</span>" +
                '<span class="sc">' + Math.round(s.chars / 1024 * 10) / 10 + "k</span></div>";
            }).join("") + "</div>"
          : '<div class="bempty sm">No native ADE memory found (CLAUDE.md, AGENTS.md, .kiro/steering). Loom reads these but never writes to them.</div>';

        el.innerHTML = '<div class="pane-inner brain">' + head + seed + '<div id="bconflicts"></div>' + list + src + "</div>";
        wireBrainSwitch(el);

        // Contradictions, above the units: two memories that likely disagree
        // are worth more attention than either alone. Quiet when clean.
        api("/api/projects/" + view.pid + "/brain/conflicts").then(function(j){
          var host = document.getElementById("bconflicts");
          if (!host || !j.conflicts || !j.conflicts.length) return;
          host.innerHTML = '<div class="bsec" style="color:var(--err)">\u26a0 ' + j.conflicts.length +
            " likely contradiction" + (j.conflicts.length === 1 ? "" : "s") +
            '<span class="bhint">resolve by forgetting or editing one side</span></div>' +
            j.conflicts.slice(0, 5).map(function(c){
              return '<div class="bconf"><span class="bconfsig">' + esc(c.signal) + "</span>" +
                '<div class="bconfpair"><div>A \u00b7 ' + esc(c.a.text.slice(0, 110)) + "</div>" +
                "<div>B \u00b7 " + esc(c.b.text.slice(0, 110)) + "</div></div></div>";
            }).join("");
        }).catch(function(){});

        Array.prototype.forEach.call(el.querySelectorAll(".bkind"), function(b){
          b.onclick = function(){ view.brainKind = b.getAttribute("data-kind"); refreshBrain(); };
        });
        Array.prototype.forEach.call(el.querySelectorAll("[data-forget]"), function(b){
          b.onclick = function(ev){
            ev.stopPropagation();
            var id = b.getAttribute("data-forget");
            var reason = window.prompt("Forget this memory — why? (kept in history)", "no longer true");
            if (reason === null) return;
            api("/api/projects/" + view.pid + "/brain/" + id + "?reason=" + encodeURIComponent(reason.trim() || "forgotten"), { method: "DELETE" })
              .then(function(){ toast("forgotten \u00b7 its history stays"); refreshBrain(); })
              .catch(function(err){ toast(err.message); });
          };
        });
        var reimp = document.getElementById("reimport");
        if (reimp) reimp.onclick = function(){
          api("/api/projects/" + view.pid + "/memory/import", { method: "POST", body: "{}" })
            .then(function(rr){ toast(rr.imported ? "imported " + rr.imported + " source(s)" : "already current"); refreshBrain(); })
            .catch(function(err){ toast(err.message); });
        };
        document.getElementById("decform").onsubmit = function(ev){
          ev.preventDefault();
          var box = document.getElementById("decbox");
          var text = (box.value || "").trim();
          if (!text) return;
          api("/api/projects/" + view.pid + "/decisions", { method: "POST", body: JSON.stringify({ text: text }) })
            .then(function(){ box.value = ""; refreshBrain(); })
            .catch(function(err){ toast(err.message); });
        };
      }).catch(function(err){ toast(err.message); });
    }

    function brainSwitchHtml(){
      return '<div class="seg bview" role="group" aria-label="whose brain">' + [["mine", "Mine"], ["team", "Team"]].map(function(o){
        return '<button type="button" data-bview="' + o[0] + '" class="' + (view.brainView === o[0] ? "on" : "") + '">' + o[1] + "</button>";
      }).join("") + "</div>";
    }

    function wireBrainSwitch(el){
      Array.prototype.forEach.call(el.querySelectorAll("[data-bview]"), function(b){
        b.onclick = function(){
          if (view.brainView === b.getAttribute("data-bview")) return;
          view.brainView = b.getAttribute("data-bview"); refreshBrain();
        };
      });
    }

    function refreshTeamBrain(sync){
      var el = document.getElementById("pane-brain"); if (!el) return;
      if (!el.querySelector(".tbrain")) {
        el.innerHTML = '<div class="pane-inner brain tbrain"><div class="bhead">' + brainSwitchHtml() + "</div>" + LOADER + "</div>";
        wireBrainSwitch(el);
      }
      api("/api/projects/" + view.pid + "/team/brain?sync=" + (sync ? 1 : 0) + "&history=" + (view.tbHistory ? 1 : 0))
        .then(drawTeamBrain, function(err){ drawTeamBrain({ error: err.message }); });
    }

    function tbChip(cls, word){ return '<span class="bbadge ' + cls + '">' + esc(word) + "</span>"; }

    function tierWord(t){ return (view.TB_TIERS.filter(function(x){ return x[0] === t; })[0] || [t, t])[1]; }

    function tbBy(m){
      var n = (m.confirmedBy || []).length;
      return (m.mine ? "yours" : m.author ? "by " + esc(m.author) : "") + (n > 1 ? " \u00b7 confirmed by " + n : "") + (m.untrusted ? " \u00b7 untrusted" : "");
    }

    /** An action button; its POST body rides along as JSON. */
    function tbBtn(label, action, body, primary){
      return '<button type="button" class="btn xs ' + (primary ? "primary" : "outline") + '" data-tbact="' + action + '" data-tbbody="' + esc(JSON.stringify(body)) + '">' + label + "</button>";
    }

    function tbSide(tag, m){
      return '<div class="tbside"><span class="tbab">' + tag + "</span>" + tbChip("tbt-" + esc(m.tier), tierWord(m.tier)) +
        '<span class="bmtext">' + esc(m.text) + (tbBy(m) ? " <small>" + tbBy(m) + "</small>" : "") + "</span></div>";
    }

    function tbInboxHtml(it){
      var a = it.a || {}, b = it.b, acts = "";
      if ((it.type === "correction" || it.type === "contradiction") && b) {
        acts = tbBtn("Keep A", "resolve", { winner: a.id, loser: b.id }) + tbBtn("Keep B", "resolve", { winner: b.id, loser: a.id });
      } else if (it.type === "duplicate" && b) acts = tbBtn("Merge", "merge", { keep: a.id, drop: b.id }, true);
      else if (it.type === "untrusted") acts = tbBtn("Trust &amp; share", "trust", { id: a.id }, true) + tbBtn("Keep private", "private", { id: a.id });
      else if (it.type === "promote") acts = tbBtn("Propose as canon", "promote", { ids: [a.id] }, true);
      return '<div class="tbcard ' + esc(it.type) + '" data-tbin="' + esc(it.id) + '"><div class="tbih">' + tbChip("tbi-" + esc(it.type), it.type) +
        "<span>" + esc(it.detail) + "</span></div>" + tbSide(b ? "A" : "", a) + (b ? tbSide("B", b) : "") +
        (acts ? '<div class="tbacts">' + acts + "</div>" : "") + "</div>";
    }

    function tbMemHtml(m){
      var old = m.state && m.state !== "live", acts = "";
      if (!old) {
        if (m.tier !== "canon" && !m.mine) acts += tbBtn("Correct\u2026", "correct", { id: m.id });
        if (m.tier === "confirmed" || m.tier === "own") acts += tbBtn("Propose as canon", "promote", { ids: [m.id] });
        if (m.tier === "own") acts += tbBtn("Private", "private", { id: m.id });
      }
      var hist = !old ? "" : m.supersededBy
        ? "superseded by " + esc(m.supersededBy) + (m.resolvedReason ? " \u2014 " + esc(m.resolvedReason) : "") + (m.resolvedBy ? " (" + esc(m.resolvedBy) + ")" : "")
        : esc(m.state) + (m.resolvedReason ? " \u2014 " + esc(m.resolvedReason) : "") + (m.resolvedBy ? " (" + esc(m.resolvedBy) + ")" : "");
      return '<div class="bmem tbmem' + (old ? " old" : "") + '" data-tbid="' + esc(m.id) + '">' +
        '<div class="bmrow">' + tbChip("tbt-" + esc(m.tier), tierWord(m.tier)) + '<span class="bmtext">' + esc(m.text) + "</span></div>" +
        '<div class="bmmeta">' + tbChip("bk-" + esc(m.kind), m.kind) + (tbBy(m) ? " " + tbBy(m) : "") + "</div>" +
        (hist ? '<div class="tbhist">' + hist + "</div>" : "") +
        (acts ? '<div class="tbacts">' + acts + "</div>" : "") + "</div>";
    }

    function drawTeamBrain(j){
      var el = document.getElementById("pane-brain"); if (!el || view.brainView !== "team") return;
      var st = j.status || {}, h = '<div class="bhead">' + brainSwitchHtml() + "</div>";
      if (j.error) h += '<div class="tberr">' + esc(j.error) + "</div>";
      else if (!st.shared) {
        var share = typeof teamShareHtml === "function" ? teamShareHtml(view.pid, true) : "";
        h += '<div class="bempty">This project isn\u2019t shared with a team. ' + (share
          ? "Share it and its memories reach your teammates, and theirs reach your agents.</div>" + share
          : 'Set up a team in <button type="button" class="lnk" id="tbsetup">Settings \u2192 Team</button>.</div>');
      } else {
        var mems = j.memories || [], inbox = j.inbox || [];
        h += '<div class="tbtop">' + (st.repo ? "<code>" + esc(st.repo) + "</code>" : "") +
          '<span class="tbn">' + (st.canon || 0) + " canon \u00b7 " + (st.team || 0) + " team \u00b7 " + (st.confirmed || 0) + " confirmed \u00b7 " + (st.mine || 0) + " yours</span>" +
          '<span class="tbsp"><button type="button" class="btn xs ghost" id="tbhist">' + (view.tbHistory ? "Hide history" : "Show history") + "</button>" +
          '<button type="button" class="btn xs outline" id="tbsync">Sync</button></span></div>';
        if (st.lastError) h += '<div class="tberr">' + esc(st.lastError) + "</div>";
        if (view.tbPr) h += '<div class="tbpr">' + (view.tbPr.url ? 'Canon PR: <a href="' + esc(view.tbPr.url) + '" target="_blank" rel="noopener">' + esc(view.tbPr.url) + "</a>" : esc(view.tbPr.note)) +
          '<button type="button" class="iconbtn xs" id="tbprx" aria-label="dismiss">' + ICONS.x + "</button></div>";
        if (inbox.length) h += '<div class="bsec">Inbox <span class="bhint">' + inbox.length + " need" + (inbox.length === 1 ? "s" : "") + " a human</span></div>" + inbox.map(tbInboxHtml).join("");
        view.TB_TIERS.forEach(function(t){
          var rows = mems.filter(function(m){ return m.tier === t[0]; });
          if (rows.length) h += '<div class="bsec">' + t[1] + ' <span class="bhint">' + rows.length + '</span></div><div class="bmems">' + rows.map(tbMemHtml).join("") + "</div>";
        });
        if (!mems.length && !inbox.length) h += '<div class="bempty">Nothing shared yet. As you and your teammates\u2019 agents learn, durable memories show up here \u2014 confirmed by two people, they can become canon in AGENTS.md.</div>';
      }
      el.innerHTML = '<div class="pane-inner brain tbrain">' + h + "</div>";
      wireBrainSwitch(el);
      if (typeof wireTeamShare === "function") wireTeamShare(el, function(){ refreshTeamBrain(true); });
      var su = document.getElementById("tbsetup"); if (su) su.onclick = function(){ openSettingsModal("team"); };
      var hb = document.getElementById("tbhist"); if (hb) hb.onclick = function(){ view.tbHistory = !view.tbHistory; refreshTeamBrain(); };
      var sb = document.getElementById("tbsync"); if (sb) sb.onclick = function(){ teamBrainAct("sync", {}, sb); };
      var px = document.getElementById("tbprx"); if (px) px.onclick = function(){ view.tbPr = null; drawTeamBrain(j); };
      Array.prototype.forEach.call(el.querySelectorAll("[data-tbact]"), function(b){
        b.onclick = function(){
          var action = b.getAttribute("data-tbact"), body = JSON.parse(b.getAttribute("data-tbbody") || "{}");
          if (action === "correct") {
            var cur = mems.filter(function(m){ return m.id === body.id; })[0];
            var text = window.prompt("Correct this memory \u2014 what\u2019s true instead? (theirs stays in history)", cur ? cur.text : "");
            if (text === null || !text.trim()) return;
            body.text = text.trim();
          } else if (action === "resolve") {
            var why = window.prompt("Why keep this one? (the other stays in history)", "");
            if (why === null) return;
            body.reason = why.trim();
          }
          teamBrainAct(action, body, b);
        };
      });
    }

    function teamBrainAct(action, body, btn){
      if (btn) btn.disabled = true;
      return api("/api/projects/" + view.pid + "/team/brain/" + action, { method: "POST", body: JSON.stringify(body || {}) })
        .then(function(j){
          var r = j.result || {};
          if (action === "promote") {
            view.tbPr = r.prUrl && /^https?:/i.test(r.prUrl) ? { url: r.prUrl } : { note: r.note || ("proposed on " + (r.branch || "loom/canon")) };
            toast(r.prUrl ? "canon PR updated" : "proposed as canon");
          } else toast(action === "sync" ? "synced" : "done");
          if (view.tbHistory) refreshTeamBrain(); else drawTeamBrain(j); // the answer carries the live view only
        }, function(err){ toast(err.message); if (btn) btn.disabled = false; });
    }
return { refreshBrain, refreshTeamBrain };
}
