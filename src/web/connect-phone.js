/** Browser connect-phone module. See README.md for ownership and startup. */
import { api } from './connection.js';
import { clog } from './console.js';
import { esc } from './format.js';
import { ICONS,LOADER } from './icons.js';
import { toast } from './notifications.js';


  // ---- connect a phone ------------------------------------------------------
  /**
   * A QR (or copy link) that pairs the native app. Two networks to choose from —
   * the LAN and the tailnet — and, when the daemon is bound to localhost, a
   * one-click "enable phone access" that binds it to 0.0.0.0 so the phone can
   * actually reach it. Every failure is reported into the Console.
   */
  function openConnectPhone(){
    if (document.querySelector(".scrim")) return;
    var scrim = document.createElement("div"); scrim.className = "scrim";
    scrim.innerHTML = '<div class="modal phonemodal">' +
      '<div class="modalhead">Connect a phone<button class="iconbtn" id="phx" aria-label="close">' + ICONS.x + '</button></div>' +
      '<div class="modalbody">' +
        '<div class="phseg" id="phseg" role="tablist">' +
          '<button class="pho" data-net="localnet" role="tab">Local network</button>' +
          '<button class="pho" data-net="tailnet" role="tab">Tailnet</button>' +
        '</div>' +
        '<div class="phstage" id="phstage">' + LOADER + '</div>' +
        '<div class="phlinkrow" id="phlinkrow" style="display:none">' +
          '<input id="phlink" readonly spellcheck="false" aria-label="pairing link">' +
          '<button class="btn ghost" id="phcopy">Copy</button>' +
        '</div>' +
        '<div class="phhint" id="phhint"></div>' +
      '</div>' +
      '<div class="modalfoot"><span class="phexp" id="phexp"></span><span class="spacer"></span><button class="btn ghost" id="phregen">New code</button></div>' +
    '</div>';
    document.body.appendChild(scrim);
    function close(){ scrim.remove(); document.removeEventListener("keydown", onKey); }
    function onKey(e){ if (e.key === "Escape") { e.preventDefault(); close(); } }
    document.addEventListener("keydown", onKey);
    scrim.addEventListener("click", function(ev){ if (ev.target === scrim) close(); });
    document.getElementById("phx").onclick = close;

    var nets = null, current = "localnet", pollIv = null;
    function q(id){ return document.getElementById(id); }
    function stage(html){ q("phstage").innerHTML = html; q("phlinkrow").style.display = "none"; q("phhint").textContent = ""; q("phexp").textContent = ""; }
    function loadNets(){ return api("/api/pair/networks").then(function(r){ nets = r; }); }
    function setSeg(){
      Array.prototype.forEach.call(scrim.querySelectorAll(".pho"), function(b){
        var net = b.getAttribute("data-net");
        var avail = net === "tailnet" ? !!(nets && nets.tailnet && nets.tailnet.available) : true;
        b.classList.toggle("on", net === current);
        b.classList.toggle("dim", !avail);
      });
    }
    function pickDefault(){
      if (nets.tailnet && nets.tailnet.reachable) return "tailnet";
      if (nets.localnet && nets.localnet.reachable) return "localnet";
      if (nets.tailnet && nets.tailnet.available) return "tailnet";
      return "localnet";
    }
    function mint(){
      var net = nets[current];
      if (!net || !net.ip) return;
      q("phstage").innerHTML = LOADER;
      q("phlinkrow").style.display = "none";
      api("/api/pair/new", { method: "POST", body: JSON.stringify({ host: net.ip }) }).then(function(r){
        // With Loom Cloud on, the link's fragment carries the relay too, so
        // this phone will reach the machine from any network, not just this one.
        var viaCloud = /[#&]relay=/.test(r.link || "");
        q("phstage").innerHTML = '<div style="display:flex;flex-direction:column;align-items:center;gap:12px">' + (r.qrSvg
          ? '<div class="phqrcard">' + r.qrSvg + '</div>'
          : '<div class="phmsg">Scan is not available here &#8212; use the link below.</div>') +
          (viaCloud ? '<span class="cloudbadge" id="phcloud">' + ICONS.cloud + "Works anywhere via Loom Cloud</span>" : "") + "</div>";
        q("phlinkrow").style.display = "";
        q("phlink").value = r.link;
        q("phhint").innerHTML = viaCloud
          ? "Scan with your phone camera, or open the link. It pairs here, then keeps working on any network. Single use."
          : 'Scan with your phone camera, or ' + (current === "tailnet" ? "on the same tailnet " : "on the same Wi-Fi ") + 'open the link. Single use.';
        q("phexp").textContent = r.expiresAt ? "expires " + new Date(r.expiresAt).toLocaleTimeString() : "";
      }).catch(function(e){
        q("phstage").innerHTML = '<div class="phmsg">Could not create a pairing code.</div>';
        clog("error", "phone", "mint failed: " + (e && e.message), e && e.stack); toast((e && e.message) || "error");
      });
    }
    function pollTailscale(){
      pollIv = setInterval(function(){
        if (!document.body.contains(scrim)){ clearInterval(pollIv); return; } // modal closed
        api("/api/tailscale/status").then(function(s){
          if (s && s.loggedIn && s.ip){
            clearInterval(pollIv);
            loadNets().then(function(){ current = "tailnet"; render(); });
          }
        }).catch(function(){});
      }, 2500);
    }
    function startTailscale(){
      q("phstage").innerHTML = LOADER; q("phhint").textContent = "";
      api("/api/tailscale/up", { method: "POST", body: "{}" }).then(function(r){
        if (r && r.ip){ return loadNets().then(function(){ current = "tailnet"; render(); }); } // already up
        if (r && r.loginUrl){
          stage('<div class="phmsg">Almost there. Sign in to Tailscale to finish.' +
            '<div class="phdim">Open the link, approve this Mac, and this continues on its own.</div>' +
            '<a class="btn primary" href="' + esc(r.loginUrl) + '" target="_blank" rel="noreferrer">Open Tailscale sign-in</a>' +
            '<div class="phdim" id="phtswait">Waiting for you to authorize...</div></div>');
          pollTailscale();
        } else {
          stage('<div class="phmsg">Could not start Tailscale.</div>');
        }
      }).catch(function(e){
        stage('<div class="phmsg">Could not start Tailscale.</div>');
        clog("error", "phone", "tailscale up failed: " + (e && e.message), e && e.stack); toast((e && e.message) || "could not start Tailscale");
      });
    }
    function render(){
      setSeg();
      var net = nets[current];
      if (current === "tailnet" && (!nets.tailnet || !nets.tailnet.available)){
        if (nets.tailnet && nets.tailnet.signedOut){
          stage('<div class="phmsg">Tailscale is installed but signed out.' +
            '<div class="phdim">Start it here so a phone on your tailnet can reach Loom from anywhere. No shared Wi-Fi, no terminal.</div>' +
            '<button class="btn primary" id="phtsup">Start Tailscale</button></div>');
          q("phtsup").onclick = startTailscale;
        } else {
          stage('<div class="phmsg">' + esc((nets.tailnet && nets.tailnet.reason) || "Tailscale is not installed on this machine.") + '<div class="phdim">Install Tailscale on this Mac and your phone, then reopen this.</div></div>');
        }
        return;
      }
      if (!net || !net.ip){
        stage('<div class="phmsg">No ' + (current === "tailnet" ? "tailnet" : "local network") + ' address on this machine right now.</div>');
        return;
      }
      if (!net.reachable){
        stage('<div class="phmsg">Loom is bound to <code>' + esc(nets.boundHost) + '</code>, so a phone cannot reach it yet.' +
          '<div class="phdim">Enable phone access to also listen on <code>' + esc(net.ip) + '</code> so a phone on the ' + (current === "tailnet" ? "tailnet" : "same Wi-Fi") + ' can reach it. It stays behind the single-use pairing code.</div>' +
          '<button class="btn primary" id="phexpose">Enable phone access</button></div>');
        q("phexpose").onclick = function(){
          var b = this; b.disabled = true; b.textContent = "Enabling...";
          api("/api/pair/expose", { method: "POST", body: JSON.stringify({ host: net.ip }) }).then(function(){
            return loadNets();
          }).then(function(){ render(); }).catch(function(e){
            b.disabled = false; b.textContent = "Enable phone access";
            clog("error", "phone", "expose failed: " + (e && e.message), e && e.stack); toast((e && e.message) || "could not enable phone access");
          });
        };
        return;
      }
      mint();
    }

    Array.prototype.forEach.call(scrim.querySelectorAll(".pho"), function(b){
      b.onclick = function(){ current = b.getAttribute("data-net"); render(); };
    });
    q("phcopy").onclick = function(){
      var v = q("phlink").value; if (!v) return;
      function fallbackCopy(){ var el = q("phlink"); el.focus(); el.select(); try { document.execCommand("copy"); toast("link copied"); } catch (_e){ toast("copy failed"); } }
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(v).then(function(){ toast("link copied"); }).catch(fallbackCopy);
      else fallbackCopy();
    };
    q("phregen").onclick = function(){ render(); };
    stage(LOADER);
    loadNets().then(function(){ current = pickDefault(); render(); }).catch(function(e){
      stage('<div class="phmsg">Could not read the network options.</div>');
      clog("error", "phone", "networks failed: " + (e && e.message), e && e.stack); toast((e && e.message) || "error");
    });
  }
export { openConnectPhone };
