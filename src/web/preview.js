/** Browser preview module. See README.md for ownership and startup. */
import { api } from './connection.js';
import { esc } from './format.js';
import { ICONS } from './icons.js';
import { toast } from './notifications.js';
import { state } from './state.js';


  // ---- Browser -------------------------------------------------------------
  // A live page and the project's Playwright specs, in the dock beside the
  // terminals. An agent writes a browser test; this is where you watch it run
  // and — when it fails — hand the failure straight back to whoever wrote it.
  var brow = { present: false, specs: null, running: null, out: [], lastFail: null, url: "", width: 0, scheme: "", relTimer: null, bridged: false };


  // ---- dev servers (core/servers.ts) --------------------------------------
  // What this project runs, and what it's doing right now. "running" means a
  // port answered — a process that exists but never listens stays "starting",
  // which is the honest thing to say about it.
  var srv = { list: [], suggested: [], log: null, lines: [], busy: {}, err: "" };


  function loadServers(){
    var el = document.getElementById("srvlist");
    if (!state.pid) {
      if (el) el.innerHTML = '<div class="specempty">Open a project to see its servers.</div>';
      return;
    }
    api("/api/projects/" + state.pid + "/servers").then(function(j){
      srv.list = j.servers || [];
      srv.suggested = j.suggested || [];
      srv.err = "";
      drawServers();
    }).catch(function(e){
      // A spinner that never stops is a lie: say what went wrong.
      srv.err = e.message;
      if (el) el.innerHTML = '<div class="specempty">' + esc(e.message) + "</div>";
    });
  }


  function serverUrl(s){
    if (s.url) return s.url;
    return s.port ? "http://localhost:" + s.port : null;
  }


  function drawServers(){
    var el = document.getElementById("srvlist"); if (!el) return;
    if (!srv.list.length) {
      el.innerHTML = '<div class="specempty">No dev servers configured.' +
        (srv.suggested.length
          ? "<br>package.json suggests <b>" + srv.suggested.map(function(x){ return esc(x.name); }).join("</b>, <b>") + "</b>" +
            ' — <button class="linkbtn" id="srvadopt">add them</button>'
          : '<br>Add them under <code>servers</code> in <code>.loom/config.json</code>.') +
        "</div>";
      var adopt = document.getElementById("srvadopt");
      if (adopt) adopt.onclick = function(){
        api("/api/projects/" + state.pid + "/servers", { method: "POST", body: JSON.stringify({ servers: srv.suggested }) })
          .then(function(j){ srv.list = j.servers || []; drawServers(); toast("added " + srv.list.length + " server" + (srv.list.length === 1 ? "" : "s")); })
          .catch(function(e){ toast(e.message); });
      };
      return;
    }
    el.innerHTML = srv.list.map(function(s){
      var st = s.state;
      var cls = st === "running" ? "ok" : st === "starting" ? "warn" : st === "crashed" ? "err" : "off";
      var why = st === "crashed" && s.exitCode !== null && s.exitCode !== undefined ? " · exit " + s.exitCode : "";
      var up = s.startedAt ? " · " + Math.max(1, Math.round((Date.now() - s.startedAt) / 1000)) + "s" : "";
      return '<div class="srvrow" data-srv="' + esc(s.name) + '">' +
        '<span class="sdot ' + cls + '"></span>' +
        '<span class="nm">' + esc(s.name) + "</span>" +
        '<span class="st">' + esc(st) + esc(why) + esc(up) + "</span>" +
        '<span class="acts">' +
        (st === "running" || st === "starting"
          ? '<button class="iconbtn xs" data-act="stop" title="stop">' + ICONS.stop + "</button>"
          : '<button class="iconbtn xs" data-act="start" title="start">' + ICONS.play + "</button>") +
        '<button class="iconbtn xs" data-act="restart" title="restart">' + ICONS.refresh + "</button>" +
        '<button class="iconbtn xs" data-act="log" title="output">' + ICONS.console + "</button>" +
        "</span></div>";
    }).join("");
    Array.prototype.forEach.call(el.querySelectorAll(".srvrow"), function(row){
      var name = row.getAttribute("data-srv");
      var s = srv.list.filter(function(x){ return x.name === name; })[0] || {};
      // The row itself points the preview at the server — the reason it's here.
      row.onclick = function(ev){
        if (ev.target.closest("[data-act]")) return;
        var url = serverUrl(s);
        if (!url) return toast(name + " has no port or url to preview");
        var input = document.getElementById("browurl");
        if (input) input.value = url;
        // Through Loom's own proxy: same page, plus a script that reports what
        // it logs and fetches. Falling back to the plain URL keeps the preview
        // working even when the proxy can't start.
        api("/api/projects/" + state.pid + "/servers/" + encodeURIComponent(name) + "/preview", { method: "POST", body: "{}" })
          .then(function(j){ brow.bridged = true; browseTo(j.url); })
          .catch(function(){ brow.bridged = false; browseTo(url); });
      };
      Array.prototype.forEach.call(row.querySelectorAll("[data-act]"), function(b){
        b.onclick = function(ev){
          ev.stopPropagation();
          var act = b.getAttribute("data-act");
          if (act === "log") return showServerLog(name);
          srv.busy[name] = true;
          api("/api/projects/" + state.pid + "/servers/" + encodeURIComponent(name) + "/" + act, { method: "POST", body: "{}" })
            .then(function(){ delete srv.busy[name]; loadServers(); })
            .catch(function(e){ delete srv.busy[name]; toast(e.message); });
        };
      });
    });
  }


  /** A server's own output, under the page it serves. */
  function showServerLog(name){
    srv.log = name;
    var wrap = document.getElementById("srvlog");
    var title = document.getElementById("srvlogname");
    if (title) title.textContent = name;
    if (wrap) wrap.style.display = "flex";
    var close = document.getElementById("srvlogclose");
    if (close) close.onclick = function(){ srv.log = null; wrap.style.display = "none"; };
    api("/api/projects/" + state.pid + "/servers/" + encodeURIComponent(name) + "/log?limit=200")
      .then(function(j){ srv.lines = j.lines || []; drawServerLog(); })
      .catch(function(e){ toast(e.message); });
  }


  function drawServerLog(){
    var el = document.getElementById("srvloglines"); if (!el) return;
    var atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    el.innerHTML = srv.lines.map(function(l){
      return '<div class="' + (l.stream === "err" ? "e" : l.stream === "loom" ? "m" : "") + '">' + esc(l.text) + "</div>";
    }).join("");
    if (atBottom) el.scrollTop = el.scrollHeight;
  }


  /** Live: a state change repaints the row, a line lands in the open log. */
  function onServerFrame(f){
    if (!f || f.projectId !== state.pid) return;
    if (f.kind === "state" && f.status) {
      var found = false;
      srv.list = srv.list.map(function(x){
        if (x.name !== f.name) return x;
        found = true;
        return f.status;
      });
      if (!found) srv.list.push(f.status);
      drawServers();
      if (f.status.state === "crashed") toast(f.name + " exited (code " + f.status.exitCode + ")");
    } else if (f.kind === "line" && f.name === srv.log) {
      srv.lines.push(f.line);
      if (srv.lines.length > 500) srv.lines.shift();
      drawServerLog();
    }
  }


  function drawBrowser(){
    var list = document.getElementById("speclist"); if (!list) return;
    if (brow.specs === null) { return; } // still loading — the loader is in place
    if (!brow.specs.length) {
      list.innerHTML = '<div class="specempty">No Playwright specs here yet.<br>' +
        "Ask an agent for one \u2014 <i>\u201cwrite a Playwright spec for the login page\u201d</i> \u2014 " +
        "and it appears in this list.</div>";
      return;
    }
    list.innerHTML = brow.specs.map(function(s){
      var running = brow.running && brow.running.file === s.path;
      return '<div class="specrow' + (running ? " running" : "") + '" data-spec="' + esc(s.path) + '" title="' +
        (running ? "running\u2026" : "run " + esc(s.path)) + '">' +
        '<span class="nm">' + esc(s.path) + "</span>" +
        (running ? '<span class="busy" style="width:8px;height:8px;color:var(--live)"></span>'
                 : '<span class="go">' + ICONS.play + "</span>") +
        "</div>";
    }).join("");
    Array.prototype.forEach.call(list.querySelectorAll("[data-spec]"), function(row){
      row.onclick = function(){ runSpec(row.getAttribute("data-spec")); };
    });
  }


  function specPrint(line, cls){
    var out = document.getElementById("specout"); if (!out) return;
    out.style.display = "";
    brow.out.push({ t: line, c: cls || "" });
    if (brow.out.length > 400) brow.out.shift();
    var atBottom = out.scrollHeight - out.scrollTop - out.clientHeight < 30;
    out.innerHTML = brow.out.map(function(l){
      return '<div class="' + l.c + '">' + esc(l.t) + "</div>";
    }).join("");
    if (atBottom) out.scrollTop = out.scrollHeight;
  }


  function refreshSpecs(){
    if (!state.pid) return;
    api("/api/projects/" + state.pid + "/specs").then(function(j){
      brow.specs = j.specs || [];
      brow.running = j.running || null;
      drawBrowser();
    }).catch(function(){
      brow.specs = [];
      drawBrowser();
    });
  }


  function runSpec(file){
    if (brow.running) { toast("a spec is already running"); return; }
    brow.out = [];
    var out = document.getElementById("specout");
    if (out) { out.innerHTML = ""; out.style.display = ""; }
    specPrint("\u25b6 " + file, "");
    api("/api/projects/" + state.pid + "/specs/run", {
      method: "POST", body: JSON.stringify({ file: file }),
    }).then(function(j){
      brow.running = { id: j.run.id, file: j.run.file };
      drawBrowser();
      if (state.redrawTermTabs) state.redrawTermTabs();
    }).catch(function(e){
      // The most common refusal is Playwright not being installed in the
      // project; the reporter line from npx lands in the stream either way.
      specPrint(e.message, "fail");
    });
  }


  /** A spec frame from the daemon — reporter output, or the run ending. */
  function onSpecFrame(frame){
    if (frame.type === "spec") {
      specPrint(frame.line, "");
      return;
    }
    // spec_done
    var failed = frame.exitCode !== 0;
    brow.running = null;
    drawBrowser();
    if (state.redrawTermTabs) state.redrawTermTabs();
    if (!failed) {
      specPrint("\u2713 " + frame.file + " passed", "pass");
      brow.lastFail = null;
      return;
    }
    specPrint("\u2717 " + frame.file + " failed (exit " + frame.exitCode + ")", "fail");
    brow.lastFail = { file: frame.file, tail: brow.out.slice(-25).map(function(l){ return l.t; }) };
    // The button that closes the loop: the failure goes back to an agent as a
    // normal message, so whoever wrote the test gets the reporter's own words.
    var out = document.getElementById("specout");
    if (out) {
      var b = document.createElement("button");
      b.className = "btn";
      b.style.cssText = "margin:8px 0 4px";
      b.textContent = "send failure to agent";
      b.onclick = function(){
        var box = document.getElementById("box");
        if (!box) return;
        box.value = "The Playwright spec " + brow.lastFail.file + " is failing:\n\n```\n" +
          brow.lastFail.tail.join("\n") + "\n```\n\nFix the app or the spec, whichever is wrong.";
        box.focus();
        toast("failure staged in the composer \u2014 pick the agent and send");
      };
      out.appendChild(b);
      out.scrollTop = out.scrollHeight;
    }
  }


  // ---- what the previewed page says (core/preview-proxy.ts) ---------------
  // The page is another origin, so it can't be read — it reports instead, over
  // postMessage, from the script Loom's proxy injects. Everything it sends is
  // one shape, so this is one reader.
  var pg = { tab: "console", console: [], network: [], picking: false };


  function pageLogTab(which){
    pg.tab = which;
    var tabs = document.getElementById("pgtabs");
    if (tabs) Array.prototype.forEach.call(tabs.querySelectorAll("[data-pg]"), function(b){
      b.classList.toggle("on", b.getAttribute("data-pg") === which);
    });
    drawPageLog();
  }


  function drawPageLog(){
    var el = document.getElementById("pglines"); if (!el) return;
    var wrap = document.getElementById("pglog");
    var rows = pg.tab === "console" ? pg.console : pg.network;
    if (wrap && rows.length && wrap.style.display === "none") wrap.style.display = "flex";
    var count = document.getElementById("pgcount");
    if (count) {
      var errs = pg.console.filter(function(r){ return r.level === "error"; }).length;
      count.textContent = pg.console.length + " log" + (pg.console.length === 1 ? "" : "s") +
        (errs ? " · " + errs + " error" + (errs === 1 ? "" : "s") : "") + " · " + pg.network.length + " request" + (pg.network.length === 1 ? "" : "s");
    }
    if (!rows.length) {
      el.innerHTML = '<div class="specempty">' +
        (pg.tab === "console" ? "Nothing logged yet." : "No requests yet.") +
        "<br>Click a line to put it in the composer.</div>";
      return;
    }
    var atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    el.innerHTML = rows.map(function(r, i){
      if (pg.tab === "console") {
        return '<div class="pgrow ' + (r.level === "error" ? "e" : r.level === "warn" ? "w" : "") + '" data-pgi="' + i + '" title="click to put this in the composer">' +
          '<span class="lv">' + esc(r.level) + "</span>" + esc(String(r.text || "").slice(0, 500)) + "</div>";
      }
      var bad = !r.status || r.status >= 400;
      return '<div class="pgrow ' + (bad ? "e" : "") + '" data-pgi="' + i + '" title="click to put this in the composer">' +
        '<span class="lv">' + esc(String(r.status || "—")) + "</span>" +
        esc(r.method + " " + String(r.url || "").slice(0, 200)) + '<span class="ms">' + (r.ms || 0) + "ms</span></div>";
    }).join("");
    Array.prototype.forEach.call(el.querySelectorAll("[data-pgi]"), function(row){
      row.onclick = function(){ pageLineToComposer(rows[Number(row.getAttribute("data-pgi"))]); };
    });
    if (atBottom) el.scrollTop = el.scrollHeight;
  }


  /** The line, as the context an agent needs — the whole point of the pane. */
  function pageLineToComposer(r){
    if (!r) return;
    var box = document.getElementById("box"); if (!box) return;
    var text;
    if (pg.tab === "console") {
      text = "From the page console (" + r.level + "):\n" + String(r.text || "") + (r.stack ? "\n" + r.stack : "");
    } else {
      text = "From the page's network: " + r.method + " " + r.url + " → " + (r.status || "failed") +
        " in " + (r.ms || 0) + "ms" + (r.error ? "\n" + r.error : "");
    }
    box.value = box.value ? box.value.replace(/\s*$/, "") + "\n\n" + text : text;
    if (state.composer) state.composer.autosize();
    box.focus();
    toast("added to the composer");
  }


  /** Ask the page which element you mean, and take its answer. */
  function togglePick(){
    var frame = document.querySelector("#browframe iframe");
    if (!frame || !frame.contentWindow) return toast("open a preview first");
    if (!brow.bridged) return toast("pick works on a server previewed through Loom — click a server row");
    pg.picking = !pg.picking;
    var btn = document.getElementById("pgpick");
    if (btn) btn.classList.toggle("on", pg.picking);
    frame.contentWindow.postMessage({ source: "loom-app", kind: pg.picking ? "pick" : "cancel-pick" }, "*");
    if (pg.picking) toast("click the element you mean");
  }


  /** One reader for everything the injected bridge sends. */
  function onPreviewMessage(ev){
    var d = ev && ev.data;
    if (!d || d.source !== "loom-preview") return;
    var p = d.payload || {};
    if (d.kind === "console") {
      pg.console.push(p);
      if (pg.console.length > 300) pg.console.shift();
      drawPageLog();
    } else if (d.kind === "network") {
      pg.network.push(p);
      if (pg.network.length > 300) pg.network.shift();
      drawPageLog();
    } else if (d.kind === "picked") {
      pg.picking = false;
      var btn = document.getElementById("pgpick");
      if (btn) btn.classList.remove("on");
      var box = document.getElementById("box");
      if (box) {
        var lines = ["About this element on " + (p.url || "the page") + " (" + conditions() + "):",
          "  selector: " + p.selector,
          "  text: " + (p.text || "(none)"),
          "  box: " + p.rect.w + "×" + p.rect.h + " at " + p.rect.x + "," + p.rect.y,
          "  html: " + String(p.html || "").slice(0, 400)].join("\n");
        box.value = box.value ? box.value.replace(/\s*$/, "") + "\n\n" + lines : lines;
        if (state.composer) state.composer.autosize();
        box.focus();
      }
      toast("element added to the composer");
    } else if (d.kind === "ready") {
      // a fresh page: its old lines belong to the page that's gone
      pg.console = [];
      pg.network = [];
      drawPageLog();
      // …and a fresh page is the page as it shipped, so the scheme you chose
      // has to be asked for again. Every reload, every hot rebuild.
      if (brow.scheme) applyBrowScheme();
    }
  }


  /** Point the preview at a URL — the address bar, or a server row. */
  function browseTo(u){
    if (!u) return;
    if (!/^https?:\/\//.test(u)) u = "http://" + u;
    brow.url = u;
    var host = document.getElementById("browframe");
    if (host) {
      host.innerHTML = '<iframe src="' + esc(u) + '" sandbox="allow-scripts allow-same-origin allow-forms"></iframe>';
      applyBrowWidth();
    }
  }


  /** Load and wire whatever the Browser pane is showing right now. */
  function fillBrowserPane(){
    if (brow.specs === null) refreshSpecs();
    loadServers();
    var sre = document.getElementById("srvreload");
    if (sre) sre.onclick = loadServers;
    var re = document.getElementById("specreload");
    if (re) re.onclick = function(){ brow.specs = null; refreshSpecs(); };
    var go = document.getElementById("browgo");
    var url = document.getElementById("browurl");
    var nav = function(){ browseTo((url && url.value || "").trim()); };
    if (go) go.onclick = nav;
    if (url) url.onkeydown = function(ev){ if (ev.key === "Enter") { ev.preventDefault(); nav(); } };

    // Width presets: "it breaks on mobile" should be reproducible in the pane
    // where the work happens, not only in another window. Both the width and
    // the scheme are read back per project — they were being saved and never
    // restored, which is the same as not remembering them.
    try {
      var savedW = localStorage.getItem("loomBrowW:" + state.pid);
      if (savedW !== null) brow.width = Number(savedW) || 0;
      var savedS = localStorage.getItem("loomBrowS:" + state.pid);
      if (savedS === "dark" || savedS === "light") brow.scheme = savedS;
    } catch (e) {}
    var sizes = document.getElementById("browsizes");
    if (sizes) Array.prototype.forEach.call(sizes.querySelectorAll("[data-w]"), function(b){
      b.classList.toggle("on", Number(b.getAttribute("data-w")) === (brow.width || 0));
      b.onclick = function(){
        brow.width = Number(b.getAttribute("data-w")) || 0;
        try { localStorage.setItem("loomBrowW:" + state.pid, String(brow.width)); } catch (e) {}
        Array.prototype.forEach.call(sizes.querySelectorAll("[data-w]"), function(x){
          x.classList.toggle("on", Number(x.getAttribute("data-w")) === brow.width);
        });
        applyBrowWidth();
      };
    });
    var schemes = document.getElementById("browscheme");
    if (schemes) Array.prototype.forEach.call(schemes.querySelectorAll("[data-s]"), function(b){
      b.classList.toggle("on", b.getAttribute("data-s") === brow.scheme);
      b.onclick = function(){
        brow.scheme = b.getAttribute("data-s") || "";
        try { localStorage.setItem("loomBrowS:" + state.pid, brow.scheme); } catch (e) {}
        Array.prototype.forEach.call(schemes.querySelectorAll("[data-s]"), function(x){
          x.classList.toggle("on", (x.getAttribute("data-s") || "") === brow.scheme);
        });
        applyBrowScheme();
      };
    });
    var rl = document.getElementById("browreload");
    if (rl) rl.onclick = function(){ if (brow.url) browseTo(brow.url); };
    var auto = document.getElementById("browautorel");
    if (auto) {
      try { auto.checked = localStorage.getItem("loomBrowAuto") !== "0"; } catch (e) {}
      auto.onchange = function(){ try { localStorage.setItem("loomBrowAuto", auto.checked ? "1" : "0"); } catch (e) {} };
    }
    var shot = document.getElementById("browshot");
    if (shot) shot.onclick = shootPreview;
    var tabs = document.getElementById("pgtabs");
    if (tabs) Array.prototype.forEach.call(tabs.querySelectorAll("[data-pg]"), function(b){
      b.onclick = function(){ pageLogTab(b.getAttribute("data-pg")); };
    });
    var pgc = document.getElementById("pgclear");
    if (pgc) pgc.onclick = function(){ pg.console = []; pg.network = []; drawPageLog(); };
    var pick = document.getElementById("pgpick");
    if (pick) pick.onclick = togglePick;
    drawPageLog();
    drawBrowser();
  }


  /**
   * Reload the preview after an agent's turn changed files.
   *
   * Coalesced, because a turn lands its diff once but a rebuild takes a moment
   * — and skipped when the page updates itself (a framework with HMR gets
   * there first, and a hard reload would throw away its state).
   */
  function maybeReloadPreview(){
    if (!brow.present || !brow.url) return;
    var auto = document.getElementById("browautorel");
    if (auto && !auto.checked) return;
    if (brow.relTimer) clearTimeout(brow.relTimer);
    brow.relTimer = setTimeout(function(){
      brow.relTimer = null;
      var host = document.getElementById("browframe");
      var frame = host && host.querySelector("iframe");
      if (!frame) return;
      // Re-point rather than frame.contentWindow.location.reload(): the page is
      // another origin, and touching its window from here throws.
      frame.src = frame.src;
    }, 900);
    state.timers.push(brow.relTimer);
  }


  /** The conditions the preview is being viewed under, in words. */
  function conditions(){
    return (brow.width ? brow.width + "px wide" : "fit to the pane") +
      ", " + (brow.scheme ? brow.scheme + " mode" : "your OS colour scheme");
  }


  /** Add a line to the composer without clobbering what's already typed. */
  function noteConditions(line){
    var box = document.getElementById("box");
    if (!box) return;
    box.value = box.value ? box.value.replace(/\s*$/, "") + "\n" + line : line;
    if (state.composer) state.composer.autosize();
  }


  /**
   * Ask the previewed page to render as if the OS were set this way.
   *
   * It can only be asked — the bridge inside the page is what re-points its
   * prefers-color-scheme rules — so a page Loom isn't proxying gets told
   * that plainly instead of a switch that does nothing. The capture path
   * (screenshot) drives a real browser and honours it either way.
   */
  function applyBrowScheme(){
    var host = document.getElementById("browframe");
    var frame = host && host.querySelector("iframe");
    if (!frame || !frame.contentWindow) return;
    if (!brow.bridged && brow.scheme) {
      toast("the shot will be in " + brow.scheme + " mode — the live frame needs a server previewed through Loom");
    }
    try {
      frame.contentWindow.postMessage({ source: "loom-app", kind: "scheme", value: brow.scheme || null }, "*");
    } catch (e) {}
  }


  /** The emulated width, scaled down when the pane is narrower than it. */
  function applyBrowWidth(){
    var host = document.getElementById("browframe");
    var frame = host && host.querySelector("iframe");
    if (!frame) return;
    if (!brow.width) {
      frame.style.width = "100%";
      frame.style.height = "100%";
      frame.style.transform = "";
      host.classList.remove("sized");
      return;
    }
    host.classList.add("sized");
    var avail = host.clientWidth - 16;
    var scale = Math.min(1, avail / brow.width);
    frame.style.width = brow.width + "px";
    frame.style.height = Math.round(host.clientHeight / scale) + "px";
    frame.style.transformOrigin = "top center";
    frame.style.transform = "scale(" + scale.toFixed(3) + ")";
  }


  /**
   * A picture of what's on screen, into the composer.
   *
   * The frame is another origin, so the page can't photograph it — the daemon
   * does, with the project's own Playwright, at the width being previewed.
   */
  function shootPreview(){
    if (!brow.url) return toast("point the preview at something first");
    var composer = state.composer;
    if (!composer || composer.projectId !== state.pid) return toast("open a project first");
    var btn = document.getElementById("browshot");
    if (btn) btn.disabled = true;
    var host = document.getElementById("browframe");
    var w = brow.width || (host ? Math.max(320, host.clientWidth) : 1280);
    toast("taking a screenshot…");
    api("/api/projects/" + state.pid + "/preview/screenshot", {
      method: "POST",
      body: JSON.stringify({
        url: brow.url,
        width: w,
        height: host ? Math.max(400, host.clientHeight) : 800,
        // The capture drives a real browser, so the scheme is truthful here
        // whether or not the live frame could be asked.
        colorScheme: brow.scheme === "dark" ? "dark" : "light",
      }),
    }).then(function(j){
      if (btn) btn.disabled = false;
      // Same path a pasted image takes: a chip in the composer, sent as a path.
      if (state.composer !== composer) return; // navigation replaced the recipient
      composer.addAttachment({ name: "preview.png", kind: "image", uploading: false, thumb: null, path: j.path });
      // The conditions ride along with the picture: an agent reading "it looks
      // wrong" needs to know at what width, in which scheme.
      noteConditions("Screenshot taken at " + j.width + "×" + j.height + ", " + j.colorScheme + " mode.");
      toast("added to the composer · " + j.width + "×" + j.height + " · " + j.colorScheme);
    }).catch(function(e){
      if (btn) btn.disabled = false;
      toast(e.message);
    });
  }


  function openBrowser(){
    if (state.showBrowser) state.showBrowser();
    fillBrowserPane();
  }


  function closeBrowser(){
    if (state.hideBrowser) state.hideBrowser();
    else brow.present = false;
  }
export { applyBrowScheme,applyBrowWidth,brow,browseTo,closeBrowser,conditions,drawBrowser,drawPageLog,drawServerLog,drawServers,fillBrowserPane,loadServers,maybeReloadPreview,noteConditions,onPreviewMessage,onServerFrame,onSpecFrame,openBrowser,pageLineToComposer,pageLogTab,pg,refreshSpecs,runSpec,serverUrl,shootPreview,showServerLog,specPrint,srv,togglePick };
