/** Browser state module. See README.md for ownership and startup. */


  var TOKEN_KEY = "loomClientToken";

  // The id (not the token) of this paired client, so Settings > Devices can mark
  // "this device" and warn before you revoke the seat you're sitting in.
  var CLIENT_ID_KEY = "loomClientId";

  var THEME_KEY = "loomTheme";

  // Shown once, unprompted, on a client that has never seen it.
  var SETUP_SEEN_KEY = "loomSetupSeen";

  var state = { token: localStorage.getItem(TOKEN_KEY) || "", clientId: localStorage.getItem(CLIENT_ID_KEY) || "", projects: [], pid: null,
                project: null, selected: null, lastId: 0, ws: null, timers: [],
                tab: "thread", tree: null, wsLive: false, lastQuestion: null,
                // auto: let the router pick who runs the turn. cpanel: which
                // composer growth panel (MCP / Skills) is open, if any.
                auto: false, cpanel: null };

  var root = document.getElementById("root");
export { CLIENT_ID_KEY,SETUP_SEEN_KEY,THEME_KEY,TOKEN_KEY,root,state };
