/** Browser clipboard module. See README.md for ownership and startup. */
import { toast } from './notifications.js';


  // The async clipboard is the good path and it is also the one that refuses:
  // no permission, no user gesture, an insecure origin. Falling back to a
  // throwaway textarea and execCommand is deprecated and still works
  // everywhere, which is the whole argument for keeping it.
  function copyFallback(v){
    try {
      var ta = document.createElement("textarea");
      ta.value = v;
      ta.setAttribute("readonly", "");
      ta.style.cssText = "position:fixed;top:0;left:0;width:1px;height:1px;opacity:0";
      document.body.appendChild(ta);
      ta.select(); ta.setSelectionRange(0, v.length);
      var ok = document.execCommand("copy");
      document.body.removeChild(ta);
      return ok;
    } catch (e) { return false; }
  }

  function copyText(v){
    function missed(){
      toast(copyFallback(v) ? "copied" : "copy failed \u2014 select it and copy by hand");
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(v).then(function(){ toast("copied"); }, missed);
    } else missed();
  }
export { copyFallback,copyText };
