/** Browser navigation module. See README.md for ownership and startup. */
import { renderPair } from './connection.js';
import { renderBoard } from './home.js';
import { renderProject } from './project.js';
import { isDesktop,renderShell } from './shell.js';
import { root,state } from './state.js';
import { applyTheme } from './theme.js';


  function route(){
    applyTheme();
    // drop every hook the old view installed — each closes over that render's
    // DOM and state (retheme holds its terminals), and the next view reinstalls
    // whichever ones it owns
    state.composer = null;
    state.toggleTerm = null;
    state.selectProject = null;
    state.drawRail = null;
    state.startTerminals = null;
    state.retheme = null;
    // palette hooks close over the old render's DOM — drop them too
    state.openFile = null; state.showTab = null; state.showRail = null; state.teamBrainPing = null;
    state.selectAgent = null; state.termRun = null; state.setChat = null;
    state.reloadBoard = null; state.setComposerMode = null; state.openPrompts = null;
    state.redrawFeed = null;
    if (!state.token) return renderPair();
    if (isDesktop()) return renderShell();
    var m = location.hash.match(/^#p\/(.+)$/);
    if (m) return renderProject(m[1], root, false);
    renderBoard();
  }

  // Global shortcuts: Ctrl+backtick toggles the terminal; "n" opens New task
  // (both only while a desktop workspace is mounted, never while typing).
  function typingInField(t){
    if (!t) return false;
    var tag = t.tagName;
    return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || t.isContentEditable;
  }

  // Same-machine window? Ask the daemon for the admin token so this becomes the
  // local admin console — pair phones, open phone access. Remote windows (a phone
  // on the tailnet) get 403 here and pair like any other device. In-memory only:
  // we never persist the admin token, so a stale one can't outlive a restart.
  function bootstrapAdmin(){
    return fetch("/api/bootstrap").then(function(r){
      if (!r.ok) return false;
      return r.json().then(function(j){
        if (j && j.token) { state.token = j.token; state.admin = true; return true; }
        return false;
      });
    }).catch(function(){ return false; });
  }
export { bootstrapAdmin,route,typingInField };
