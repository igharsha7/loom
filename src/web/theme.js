/** Browser theme module. See README.md for ownership and startup. */
import { ICONS } from './icons.js';
import { THEME_KEY,state } from './state.js';


  function themeNow(){ return localStorage.getItem(THEME_KEY) === "light" ? "light" : "dark"; }

  function applyTheme(){
    var t = themeNow();
    document.documentElement.classList.toggle("dark", t !== "light");
    var m = document.querySelector('meta[name="theme-color"]');
    if (m) m.setAttribute("content", t === "light" ? "#ffffff" : "#0a0a0a");
    var tb = document.getElementById("themebtn");
    if (tb) tb.innerHTML = t === "light" ? ICONS.moon : ICONS.sun;
  }

  function bindTheme(){
    var tb = document.getElementById("themebtn");
    if (!tb) return;
    tb.innerHTML = themeNow() === "light" ? ICONS.moon : ICONS.sun;
    tb.onclick = function(){
      localStorage.setItem(THEME_KEY, themeNow() === "light" ? "dark" : "light");
      applyTheme();
      if (state.retheme) state.retheme(); // live terminals repaint too
    };
  }

  var THEME_BTN = '<button id="themebtn" class="iconbtn" title="toggle theme"></button>';

  function isElectron(){ return document.documentElement.hasAttribute("data-electron"); }
export { THEME_BTN,applyTheme,bindTheme,isElectron,themeNow };
