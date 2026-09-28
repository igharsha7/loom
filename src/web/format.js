/** Browser format module. See README.md for ownership and startup. */
import { ICONS } from './icons.js';


  /**
   * Is this window still here?
   *
   * A reply can land after the window has gone — a closed tab, a torn-down
   * test — and the document is undefined by then. A late redraw that throws
   * turns into an unhandled rejection and blames whatever ran next, so the
   * few redraws that late replies reach ask first.
   */
  function pageGone(){ return typeof document === "undefined" || !document; }


  function esc(s){ return String(s == null ? "" : s).replace(/[&<>"']/g, function(c){
    return {"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]; }); }


  /**
   * A small, safe markdown renderer for agent output.
   *
   * No dependency, no build step — the app has neither. The whole input is
   * HTML-escaped FIRST, so every transform below only ever adds tags around
   * already-safe text; nothing an agent prints can inject markup. Backticks are
   * written as \x60 throughout because a literal backtick would close this
   * template literal and take the app down.
   *
   * Handles: fenced code, inline code, bold/italic/strike, headings, lists,
   * blockquotes, rules, links (http/https only), and paragraphs with soft
   * line breaks — the subset agents actually emit.
   */
  function mdInline(s){
    // s is already HTML-escaped.
    s = s.replace(/\x60([^\x60]+?)\x60/g, '<code class="mdi">$1</code>');
    s = s.replace(/\*\*([^*]+?)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/(^|[^\w*])\*([^*\n]+?)\*(?!\w)/g, "$1<em>$2</em>");
    s = s.replace(/~~([^~]+?)~~/g, "<del>$1</del>");
    // [text](url) — only http(s); the url is already entity-escaped, so &amp; etc. are safe in the attribute.
    s = s.replace(/\[([^\]]+?)\]\((https?:\/\/[^)\s]+?)\)/g,
      '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
    return s;
  }

  function mdToHtml(src){
    var lines = esc(String(src == null ? "" : src)).split("\n");
    var out = [], i = 0;
    var FENCE = /^\s*\x60\x60\x60(.*)$/, FENCE_END = /^\s*\x60\x60\x60\s*$/;
    var HEAD = /^(#{1,6})\s+(.*)$/, QUOTE = /^\s*&gt;\s?/, RULE = /^\s*(?:---|\*\*\*|___)\s*$/;
    var ULI = /^\s*[-*+]\s+/, OLI = /^\s*\d+\.\s+/;
    while (i < lines.length) {
      var line = lines[i];
      if (FENCE.test(line)) {
        var code = [], j = i + 1;
        while (j < lines.length && !FENCE_END.test(lines[j])) { code.push(lines[j]); j++; }
        // A code block used to scroll sideways with no way to reach the end,
        // which is how an orchestrator's whole plan became unreadable. It
        // wraps now, and carries a copy button for the times you want it
        // somewhere else rather than on screen.
        out.push('<div class="mdcodewrap"><button class="mdcopy" type="button" title="copy">' + ICONS.copy +
          '</button><pre class="mdcode"><code>' + code.join("\n") + "</code></pre></div>");
        i = j + 1; continue;
      }
      var h = line.match(HEAD);
      if (h) { out.push('<div class="mdh mdh' + Math.min(6, h[1].length) + '">' + mdInline(h[2]) + "</div>"); i++; continue; }
      if (QUOTE.test(line)) {
        var q = [];
        while (i < lines.length && QUOTE.test(lines[i])) { q.push(lines[i].replace(QUOTE, "")); i++; }
        out.push('<blockquote class="mdq">' + mdInline(q.join(" ")) + "</blockquote>"); continue;
      }
      if (RULE.test(line)) { out.push('<hr class="mdhr">'); i++; continue; }
      if (ULI.test(line) || OLI.test(line)) {
        var ordered = OLI.test(line), items = [];
        while (i < lines.length && (ULI.test(lines[i]) || OLI.test(lines[i]))) {
          items.push("<li>" + mdInline(lines[i].replace(/^\s*(?:[-*+]|\d+\.)\s+/, "")) + "</li>"); i++;
        }
        out.push("<" + (ordered ? "ol" : "ul") + ' class="mdlist">' + items.join("") + "</" + (ordered ? "ol" : "ul") + ">"); continue;
      }
      if (!line.trim()) { i++; continue; }
      var para = [];
      while (i < lines.length && lines[i].trim() && !FENCE.test(lines[i]) && !HEAD.test(lines[i]) &&
             !QUOTE.test(lines[i]) && !RULE.test(lines[i]) && !ULI.test(lines[i]) && !OLI.test(lines[i])) {
        para.push(lines[i]); i++;
      }
      out.push('<div class="mdp">' + mdInline(para.join("<br>")) + "</div>");
    }
    return out.join("");
  }

  /**
   * Mark the match inside a line.
   *
   * Module scope, not inside a render function: the code search (renderProject)
   * and the chat search (renderShell) both call it, and when it lived in the
   * first of those the second threw a ReferenceError inside a .then() — the
   * header rendered, the rows silently didn't, and nothing reached the console.
   * That is the fourth time today a function has been called from the wrong
   * scope in this file.
   *
   * esc() first, always: this is a line of someone's source code and it will
   * contain angle brackets. Escaping after inserting the mark would eat the
   * mark; escaping the query too means a search for "<div" highlights rather
   * than injects.
   */
  function highlight(text, q){
    var safe = esc(String(text));
    var needle = esc(String(q));
    var at = safe.toLowerCase().indexOf(needle.toLowerCase());
    if (at < 0) return safe;
    return safe.slice(0, at) + "<mark>" + safe.slice(at, at + needle.length) + "</mark>" + safe.slice(at + needle.length);
  }

  function hue(id){ var h = 0; for (var i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 360; return h; }

  // Zero is "$0", not "$0.0000" — four decimals of nothing reads as fake
  // precision (and free-model turns genuinely cost nothing). Sub-cent but real
  // costs still show four places; anything that would round to $0.0000 is $0.
  /** A token count at a glance: 950, 12.3k, 1.2M. */
  function tokens(n){ n = Number(n) || 0; if (n < 1000) return String(Math.round(n));
    if (n < 1e6) return (n < 1e4 ? (n / 1e3).toFixed(1) : String(Math.round(n / 1e3))) + "k"; return (n / 1e6).toFixed(1) + "M"; }
  function money(n){ n = Number(n) || 0; if (n < 0.00005) return "$0"; return "$" + (n >= 0.01 ? n.toFixed(2) : n.toFixed(4)); }

  /** Compact "3m ago" / "2h ago" / "5d ago" from an epoch-ms timestamp. */
  function rel(ts){
    var s = Math.max(0, Math.floor((Date.now() - ts) / 1000));
    if (s < 45) return "just now";
    if (s < 3600) return Math.round(s / 60) + "m ago";
    if (s < 86400) return Math.round(s / 3600) + "h ago";
    return Math.round(s / 86400) + "d ago";
  }
export { esc,highlight,hue,mdInline,mdToHtml,money,pageGone,rel,tokens };
