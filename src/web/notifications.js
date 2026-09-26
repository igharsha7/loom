/** Browser notifications module. See README.md for ownership and startup. */
import { state } from './state.js';


  // a request that fails after the page is gone (a closed tab, a torn-down test window) has no one to tell
  function toast(msg){ if (typeof document === "undefined" || !document) return; var t = document.getElementById("toast"); if (!t) return; t.textContent = msg;
    t.classList.add("show"); clearTimeout(t._t); t._t = setTimeout(function(){ t.classList.remove("show"); }, 2600); }

  /** Assertive screen-reader announcement for high-stakes moments (an agent
   *  needs you). Cleared then re-set so repeats are re-announced. */
  function announce(msg){ var a = document.getElementById("a11y-alert"); if (!a) return;
    a.textContent = ""; setTimeout(function(){ a.textContent = msg; }, 60); }

  /** The core alert. An agent is blocked on the human — the one moment Loom is
   *  built to surface. Reach the user through every channel that isn't already
   *  looking: assertive SR announce, a title flash while the tab is hidden, and
   *  an OS notification when permitted. Restored on the next focus. */
  var _titleFlash = null, _baseTitle = "Loom";

  function stopTitleFlash(){ if (_titleFlash){ clearInterval(_titleFlash); _titleFlash = null; document.title = _baseTitle; } }

  function notifyNeedsInput(ev){
    var who = (ev && ev.agentId) || "an agent";
    var q = ev && ev.payload && ev.payload.question ? ev.payload.question : "";
    announce(who + " needs input" + (q ? ": " + q : ""));
    toast("\u23f8 " + who + " needs you");
    // The desktop shell can do better than a browser notification: a native
    // one carrying the question, answerable where the OS allows it. Quiet when
    // the window is focused and already on that conversation — a notification
    // about what you are looking at is noise.
    if (window.loomNative && window.loomNative.notify) {
      var nchat = (ev && ev.chat) || "main";
      var here = state.currentChat ? state.currentChat() : "main";
      if (document.hidden || nchat !== here) {
        try {
          window.loomNative.notify({
            title: who + " needs you",
            body: q || "Loom · an agent is waiting on you",
            chat: nchat,
            project: state.pid || null,
            agentId: (ev && ev.agentId) || null
          });
        } catch (e) {}
      }
      return;
    }
    if (document.hidden){
      if (!_titleFlash){ var on = false; _titleFlash = setInterval(function(){
        document.title = (on = !on) ? "\u23f8 " + who + " needs you" : _baseTitle; }, 1100); }
      try {
        if (window.Notification && Notification.permission === "granted"){
          new Notification(who + " needs input", { body: q || "Loom \u00b7 an agent is waiting on you", tag: "loom-needs-input" });
        } else if (window.Notification && Notification.permission === "default"){
          Notification.requestPermission();
        }
      } catch (e) {}
    }
  }
export { _baseTitle,_titleFlash,announce,notifyNeedsInput,stopTitleFlash,toast };
