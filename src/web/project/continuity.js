import { api } from '../connection.js';
import { ICONS } from '../icons.js';

export function showContinuityOverflow(view, result){
      var scrim = document.createElement("div"); scrim.className = "scrim";
      scrim.innerHTML = '<div class="modal"><div class="modalhead">Context needs review<button class="iconbtn" data-close aria-label="close">' + ICONS.x + '</button></div>' +
        '<div class="modalbody"><p>Your request is saved and has not been submitted. Protected user context exceeds the added-context target.</p>' +
        '<p>Review the packet before increasing the target. This can consume more provider quota; the native context limit is not known.</p>' +
        '<details><summary>Packet and coverage</summary><pre data-packet style="max-height:280px;overflow:auto;white-space:pre-wrap">Loading…</pre></details>' +
        '<details><summary>Create a reviewed checkpoint</summary><p>Select historical messages to replace with a summary. Keep small decisions, exact constraints and unresolved questions.</p>' +
        '<div data-sources style="max-height:220px;overflow:auto"></div><textarea data-summary aria-label="Reviewed context summary" placeholder="Reviewed summary, including exact constraints and unresolved questions"></textarea>' +
        '<label><input data-reviewed type="checkbox"> I reviewed the selected originals and this summary</label><button class="btn" data-checkpoint>Save checkpoint</button></details>' +
        '<label>Added-context target (estimated tokens) <input data-target type="number" min="128" max="100000" value="12000"></label>' +
        '<p data-error role="status"></p><button class="btn primary" data-resume>Resume saved request</button></div></div>';
      document.body.appendChild(scrim);
      function close(){ scrim.remove(); document.removeEventListener("keydown", key); }
      function key(e){ if(e.key === "Escape") close(); }
      document.addEventListener("keydown", key);
      scrim.querySelector("[data-close]").onclick = close;
      scrim.addEventListener("click", function(e){ if(e.target === scrim) close(); });
      var packet, checkpointJob;
      api("/api/projects/" + view.pid + "/brain/continuity?requestId=" + encodeURIComponent(result.requestId)).then(function(data){
        var latest = data.receipts && data.receipts[data.receipts.length - 1];
        if(!latest || !latest.packet) throw new Error("No prepared packet was found");
        return api("/api/projects/" + view.pid + "/brain/continuity/packets/" + encodeURIComponent(latest.packet.id));
      }).then(function(data){
          scrim.querySelector("[data-packet]").textContent = JSON.stringify(data, null, 2);
          packet = data.packet;
          scrim.querySelector("[data-target]").value = Math.min(100000, Math.ceil(packet.budget.estimatedAddedTokens * 1.2));
          packet.messages.forEach(function(message, index){
            var label = document.createElement("label"), checkbox = document.createElement("input"), text = document.createElement("span");
            checkbox.type = "checkbox"; checkbox.setAttribute("data-source", index);
            text.textContent = message.text; label.style.display = "block"; label.append(checkbox, text);
            scrim.querySelector("[data-sources]").appendChild(label);
          });
      }).catch(function(e){ scrim.querySelector("[data-error]").textContent = e.message; });
      scrim.querySelector("[data-checkpoint]").onclick = function(){
        if(!packet) { scrim.querySelector("[data-error]").textContent = "Wait for the packet to load."; return; }
        var selected = Array.from(scrim.querySelectorAll("[data-source]:checked")).map(function(input){ return packet.messages[Number(input.getAttribute("data-source"))].source; });
        var summary = scrim.querySelector("[data-summary]").value.trim();
        if(!selected.length || !summary || !scrim.querySelector("[data-reviewed]").checked) {
          scrim.querySelector("[data-error]").textContent = "Select originals, write the summary and confirm your review."; return;
        }
        var button = this; button.disabled = true;
        var checkpointKey = JSON.stringify([selected, summary]);
        if(!checkpointJob || checkpointJob.key !== checkpointKey) checkpointJob = { key: checkpointKey, itemId: crypto.randomUUID(), created: false };
        var job = checkpointJob, itemId = job.itemId;
        (job.created ? Promise.resolve() : api("/api/projects/" + view.pid + "/brain/continuity/items", { method: "POST", body: JSON.stringify({
          id: itemId, revision: 1, conversationId: packet.conversationId, kind: "instruction", text: summary,
          origin: "user", status: "accepted", sources: selected, supersedes: null,
        }) })).then(function(){
          job.created = true;
          return api("/api/projects/" + view.pid + "/brain/continuity/checkpoint", { method: "POST", body: JSON.stringify({
            chat: packet.conversationId, itemId: itemId, eventIds: selected.map(function(source){ return source.eventId; }), reviewed: true,
          }) });
        }).then(function(){
          scrim.querySelector("[data-error]").textContent = "Checkpoint saved. Originals remain stored. Resume the saved request to rebuild its packet.";
          button.disabled = true;
          button.textContent = "Checkpoint saved";
        }).catch(function(e){ button.disabled = false; scrim.querySelector("[data-error]").textContent = e.message; });
      };
      scrim.querySelector("[data-resume]").onclick = function(){
        var button = this; button.disabled = true;
        api("/api/projects/" + view.pid + "/brain/continuity/requests/" + encodeURIComponent(result.requestId) + "/resume", {
          method: "POST", body: JSON.stringify({ targetAddedTokens: Number(scrim.querySelector("[data-target]").value) }),
        }).then(function(next){ close(); view.refresh(); if(next.continuityStatus === "overflow") showContinuityOverflow(view, next); })
          .catch(function(e){ button.disabled = false; scrim.querySelector("[data-error]").textContent = e.message; });
      };
    }
