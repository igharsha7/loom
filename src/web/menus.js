/** Browser menus module. See README.md for ownership and startup. */
import { esc } from './format.js';

  /** A tiny action menu anchored under a button (the SCM commit split, etc.). */
  function openScmMenu(anchor, items){
    var ex = document.getElementById("scmmenu"); if (ex) ex.remove();
    var m = document.createElement("div"); m.id = "scmmenu"; m.className = "scmmenu";
    m.innerHTML = items.map(function(it, i){ return '<button class="scmmi" data-i="' + i + '">' + esc(it.label) + "</button>"; }).join("");
    document.body.appendChild(m);
    var r = anchor.getBoundingClientRect();
    m.style.left = Math.max(8, Math.round(r.right - m.offsetWidth)) + "px";
    m.style.top = Math.round(r.bottom + 4) + "px";
    if (r.bottom + 4 + m.offsetHeight > window.innerHeight) m.style.top = Math.max(8, Math.round(r.top - m.offsetHeight - 4)) + "px";
    Array.prototype.forEach.call(m.querySelectorAll(".scmmi"), function(b){
      b.onclick = function(ev){ ev.stopPropagation(); closeScmMenu(); items[Number(b.getAttribute("data-i"))].run(); };
    });
    setTimeout(function(){ document.addEventListener("mousedown", scmMenuAway); }, 0);
  }

  function scmMenuAway(ev){ var m = document.getElementById("scmmenu"); if (m && !m.contains(ev.target)) closeScmMenu(); }

  function closeScmMenu(){ document.removeEventListener("mousedown", scmMenuAway); var m = document.getElementById("scmmenu"); if (m) m.remove(); }

  /**
   * One floating menu, for the composer's More button and for every right
   * click.
   *
   * Anchored to a point rather than to an element, because a context menu
   * belongs where the cursor is; it flips up or left rather than hanging off
   * the edge of the window; Escape and any click outside close it; and the
   * first item takes focus so the keyboard can drive it. Items are
   * {label, icon, hint, run, danger, sep}.
   */
  function openMenu(x, y, items){
    closeMenu();
    var pop = document.createElement("div");
    pop.className = "pickpop menupop";
    pop.id = "loommenu";
    pop.setAttribute("role", "menu");
    pop.innerHTML = items.map(function(it, i){
      if (it.sep) return '<div class="menusep"></div>';
      if (it.head) return '<div class="pickhead">' + esc(it.head) + "</div>";
      return '<button class="pickrow' + (it.danger ? " danger" : "") + '" role="menuitem" data-i="' + i + '">' +
        '<span class="mico">' + (it.icon || "") + "</span>" +
        '<span class="pnm">' + esc(it.label) + "</span>" +
        (it.hint ? '<span class="prole">' + esc(it.hint) + "</span>" : "") + "</button>";
    }).join("");
    document.body.appendChild(pop);
    var r = pop.getBoundingClientRect();
    pop.style.left = Math.max(6, Math.min(x, window.innerWidth - r.width - 6)) + "px";
    pop.style.top = (y + r.height > window.innerHeight - 6 ? Math.max(6, y - r.height) : y) + "px";
    Array.prototype.forEach.call(pop.querySelectorAll("[data-i]"), function(b){
      b.onclick = function(ev){
        ev.stopPropagation();
        var it = items[Number(b.getAttribute("data-i"))];
        closeMenu();
        if (it && it.run) it.run();
      };
    });
    var first = pop.querySelector("[data-i]");
    if (first) first.focus();
    setTimeout(function(){
      document.addEventListener("mousedown", menuAway);
      document.addEventListener("keydown", menuKey);
    }, 0);
  }

  function menuAway(ev){
    var pop = document.getElementById("loommenu");
    if (pop && !pop.contains(ev.target)) closeMenu();
  }

  function menuKey(ev){
    if (ev.key === "Escape") { ev.preventDefault(); closeMenu(); return; }
    var pop = document.getElementById("loommenu");
    if (!pop || (ev.key !== "ArrowDown" && ev.key !== "ArrowUp")) return;
    ev.preventDefault();
    var rows = Array.prototype.slice.call(pop.querySelectorAll("[data-i]"));
    var at = rows.indexOf(document.activeElement);
    var next = ev.key === "ArrowDown" ? at + 1 : at - 1;
    (rows[(next + rows.length) % rows.length] || rows[0]).focus();
  }

  function closeMenu(){
    document.removeEventListener("mousedown", menuAway);
    document.removeEventListener("keydown", menuKey);
    var pop = document.getElementById("loommenu");
    if (pop) pop.remove();
  }
export { closeMenu,closeScmMenu,menuAway,menuKey,openMenu,openScmMenu,scmMenuAway };
