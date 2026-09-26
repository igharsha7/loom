/** Browser diff module. See README.md for ownership and startup. */
import { esc } from './format.js';
import { ICONS } from './icons.js';


  // ---- diff parsing (changes pane + rail) ---------------------------------
  // Loom's own state dir is workspace noise, not the user's change set.
  function isLoomInternal(path){ return String(path || "").indexOf(".loom/") === 0; }

  function visibleFiles(t){ return (t && t.files ? t.files : []).filter(function(f){ return !isLoomInternal(f.path); }); }

  function splitPatch(patch){
    var parts = [];
    var cur = null;
    String(patch || "").split("\n").forEach(function(line){
      var m = line.match(/^diff --git a\/(.+) b\/(.+)$/);
      if (m) { cur = { path: m[2], lines: [], add: 0, del: 0 }; parts.push(cur); return; }
      if (!cur) { cur = { path: "", lines: [], add: 0, del: 0 }; parts.push(cur); }
      cur.lines.push(line);
      if (line.charAt(0) === "+" && line.slice(0, 3) !== "+++") cur.add++;
      if (line.charAt(0) === "-" && line.slice(0, 3) !== "---") cur.del++;
    });
    return parts.filter(function(f){ return f.path || f.lines.join("").trim(); });
  }

  function diffLineClass(line){
    if (line.slice(0, 3) === "+++" || line.slice(0, 3) === "---" || line.slice(0, 5) === "index" || line.slice(0, 3) === "new" || line.slice(0, 7) === "deleted") return "meta";
    if (line.charAt(0) === "+") return "add";
    if (line.charAt(0) === "-") return "del";
    if (line.slice(0, 2) === "@@") return "hunk";
    return "";
  }

  // Unified diff lines with an old/new line-number gutter (Orca diff view).
  function renderDiffLines(lines, commentFile){
    var oldN = 0, newN = 0, out = "";
    lines.forEach(function(line){
      var m = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (m) {
        oldN = Number(m[1]); newN = Number(m[2]);
        out += '<div class="dl hunk full">' + esc(line) + "</div>";
        return;
      }
      var c = diffLineClass(line);
      if (c === "meta") { out += '<div class="dl meta full">' + (esc(line) || " ") + "</div>"; return; }
      var ch = line.charAt(0);
      if (!oldN && !newN && ch !== "+" && ch !== "-") {
        out += '<div class="dl full">' + (esc(line) || " ") + "</div>";
        return;
      }
      var lo = "", ln = "", mark = "";
      if (c === "add") { ln = String(newN++); mark = "+"; }
      else if (c === "del") { lo = String(oldN++); mark = "\u2212"; }
      else { lo = String(oldN++); ln = String(newN++); }
      var content = ch === "+" || ch === "-" || ch === " " ? line.slice(1) : line;
      // Reviewable rows carry their location, so a click can turn into a
      // comment that names file:line instead of "that bit somewhere".
      var loc = commentFile && ln ? ' data-cfile="' + esc(commentFile) + '" data-cline="' + ln + '"' : "";
      out += '<div class="dl' + (c ? " " + c : "") + (loc ? " cmt" : "") + '"' + loc + ">" +
        '<span class="ln">' + lo + '</span><span class="ln">' + ln + "</span>" +
        '<span class="lm">' + mark + "</span>" +
        '<span class="lc">' + (esc(content) || " ") + "</span></div>";
    });
    return out;
  }

  function renderDiffFiles(tree){
    var files = splitPatch(tree.patch).filter(function(f){ return !isLoomInternal(f.path); });
    files.forEach(function(f){
      f.lines = f.lines.filter(function(l){ return !/^\?\? new file: \.loom\//.test(l); });
    });
    files = files.filter(function(f){ return f.path || f.lines.join("").trim(); });
    if (!files.length) return '<div class="sys">working tree is clean</div>';
    return files.map(function(f, i){
      return '<div class="dfile" id="df-' + i + '">' +
        '<div class="dfh">' + ICONS.tree + '<span class="p">' + esc(f.path || "patch") + "</span>" +
        '<span class="cadd">+' + f.add + "</span><span class=\"cdel\">\u2212" + f.del + "</span></div>" +
        '<div class="dcode">' + renderDiffLines(f.lines, f.path) + "</div></div>";
    }).join("");
  }
export { diffLineClass,isLoomInternal,renderDiffFiles,renderDiffLines,splitPatch,visibleFiles };
