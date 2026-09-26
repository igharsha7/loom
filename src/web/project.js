import { createApprovalEvents } from './project/approval-events.js';
import { createBoard } from './project/board.js';
import { createBrain } from './project/brain.js';
import { createChanges } from './project/changes.js';
import { createComposer } from './project/composer.js';
import { createExplorer } from './project/explorer.js';
import { createFleet } from './project/fleet.js';
import { createObservatory } from './project/observatory.js';
import { createOrchestra } from './project/orchestra.js';
import { createQueue } from './project/queue.js';
import { createRoutes } from './project/routes.js';
import { createTerminal } from './project/terminal.js';
import { createThread } from './project/thread.js';
/** Browser project module. See README.md for ownership and startup. */
import { approvalClick,approvalKey,closeApprovalsPop,openApprovalsPop } from './approvals.js';
import { copyText } from './clipboard.js';
import { openConnectPhone } from './connect-phone.js';
import { api,clearTimers } from './connection.js';
import { bindConsole } from './console.js';
import { renderDiffLines } from './diff.js';
import { maybeDigest } from './digest.js';
import { esc } from './format.js';
import { ICONS,LOADER } from './icons.js';
import { applyRail,makeResizer,toggleRail } from './layout.js';
import { toast } from './notifications.js';
import { KMOD } from './permissions.js';
import { closeBrowser,openBrowser } from './preview.js';
import { root,state } from './state.js';
import { loadGitDelivery } from './statusbar.js';
import { loadTeam,loadTeamRunners,runnerHooks,teamEditing,teamHooks } from './team.js';
import { bindTheme } from './theme.js';


  // ---- project view (mobile: sheets · desktop: Orca workspace tabs) -------
  function renderProject(pid, mount, desktop){
    // Bind feature closures before any view setup invokes them. Accessors keep
    // asynchronous callbacks attached to this mount, never a later project.
    var { trunc, drawObservatory } = createObservatory({
      get obRefreshT() { return obRefreshT; }, set obRefreshT(value) { obRefreshT = value; },
      get ASK_SUGGESTIONS() { return ASK_SUGGESTIONS; },
      get OBPAL() { return OBPAL; },
      get obNodePos() { return obNodePos; },
    });
    var { closeDock, openChangesDock, openPatchDock, openFileDock } = createChanges({
      get pid() { return pid; },
      get drawRail() { return drawRail; }
    });
    var { curTerm, termOpen, xtermTheme, applyTerm, toggleTerm, ensureTerm, focusTerm, fitActive, addTerm, drawTermTabs, showTermPane, showConsolePane, hideConsolePane, showBrowserPane, hideBrowserPane, runCmd, interruptTerm, onTermFrame } = createTerminal({
      get terms() { return terms; },
      get activeTerm() { return activeTerm; }, set activeTerm(value) { activeTerm = value; },
      get desktop() { return desktop; },
      get TERM_KEY() { return TERM_KEY; },
      get termSeq() { return termSeq; }, set termSeq(value) { termSeq = value; },
      get pid() { return pid; },
      get termMode() { return termMode; }, set termMode(value) { termMode = value; },
      get CONSOLE_TAB() { return CONSOLE_TAB; },
      get BROWSER_TAB() { return BROWSER_TAB; },
    });
    var { refreshBrain, refreshTeamBrain } = createBrain({
      get brainView() { return brainView; }, set brainView(value) { brainView = value; },
      get pid() { return pid; },
      get brainKind() { return brainKind; }, set brainKind(value) { brainKind = value; },
      get BRAIN_KINDS() { return BRAIN_KINDS; },
      get tbHistory() { return tbHistory; }, set tbHistory(value) { tbHistory = value; },
      get TB_TIERS() { return TB_TIERS; },
      get tbPr() { return tbPr; }, set tbPr(value) { tbPr = value; }
    });
    var { routeFormHtml, bindRouteForm } = createRoutes({
      get pid() { return pid; },
      get refresh() { return refresh; }
    });
    var { loadBoard, drawBoardPane } = createBoard({
      get board() { return board; },
      get PINKEY() { return PINKEY; },
      get pid() { return pid; },
      get BCOLS() { return BCOLS; },
      get BSTATES() { return BSTATES; },
      get OWN_STATE() { return OWN_STATE; },
    });
    var { openFileFromTree, drawRail, loadDir, drawExplorer } = createExplorer({
      get refresh() { return refresh; },
      get openChangesDock() { return openChangesDock; },
      get openFileDock() { return openFileDock; },
      get expl() { return expl; },
      get pid() { return pid; },
      get refreshTree() { return refreshTree; },
      get drawStatus() { return drawStatus; }
    });
    var { drawStatus, refresh, loadHistory, connect } = createThread({
      get orchRunForChat() { return orchRunForChat; },
      get planState() { return planState; },
      get orchTerminal() { return orchTerminal; },
      get desktop() { return desktop; }, set desktop(value) { desktop = value; },
      get drawOrchTabDot() { return drawOrchTabDot; },
      get updateModelLabel() { return updateModelLabel; },
      get pid() { return pid; },
      get drawRail() { return drawRail; },
      get historyLoaded() { return historyLoaded; }, set historyLoaded(value) { historyLoaded = value; },
      get pendingWs() { return pendingWs; }, set pendingWs(value) { pendingWs = value; },
      get chatId() { return chatId; },
      get loadApprovals() { return loadApprovals; },
      get onTermFrame() { return onTermFrame; },
      get onQueueFrame() { return onQueueFrame; },
      get onOrchEvent() { return onOrchEvent; },
      get onApprovalEvent() { return onApprovalEvent; },
      get onFleetEvent() { return onFleetEvent; }
    });
    var { autosizeBox, drawAttach, closeMenu, menuAway, openModelMenu, bindComposer, updateModelLabel, openPermMenu, composerPlaceholder } = createComposer({
      get sendOrchestra() { return sendOrchestra; },
      get attach() { return attach; }, set attach(value) { attach = value; },
      get planState() { return planState; }, set planState(value) { planState = value; },
      get orchRunForChat() { return orchRunForChat; },
      get pid() { return pid; },
      get mergeOrchRun() { return mergeOrchRun; },
      get refresh() { return refresh; },
      get chatId() { return chatId; },
      get wouldQueue() { return wouldQueue; },
      get queueFromComposer() { return queueFromComposer; },
      get menuState() { return menuState; }, set menuState(value) { menuState = value; },
      get refreshBrain() { return refreshBrain; },
      get drawStatus() { return drawStatus; },
      get setComposerMode() { return setComposerMode; },
      get drawOrchControls() { return drawOrchControls; },
      get openRewindMenu() { return openRewindMenu; },
      get PLAN_KEY() { return PLAN_KEY; },
      get prompts() { return prompts; },
      get desktop() { return desktop; },
      get showTab() { return showTab; },
      get trunc() { return trunc; },
      get MCPMARK() { return MCPMARK; },
      get _sugT() { return _sugT; }, set _sugT(value) { _sugT = value; }
    });
    var { loadQueue, onQueueFrame, wouldQueue, queueFromComposer } = createQueue({
      get pid() { return pid; },
      get queue() { return queue; },
      get orchCfg() { return orchCfg; },
      get orchRoster() { return orchRoster; },
      get planState() { return planState; }, set planState(value) { planState = value; },
      get orch() { return orch; },
      get chatId() { return chatId; },
    });
    var { orchRoster, orchCfg, orchTerminal, findOrchRun, orchRunForChat, mergeOrchRun, setComposerMode, drawOrchControls, sendOrchestra, needsInputClick, answerAgent, askRewind, openRewindMenu, openOrchChat, loadOrch, onOrchEvent, drawOrchTabDot, orchEl, openOrchSheet, closeOrchSheet, orchPill, drawOrch, redeliverOrch, applyOrch } = createOrchestra({
      get orch() { return orch; },
      get chatId() { return chatId; },
      get composerPlaceholder() { return composerPlaceholder; },
      get menuState() { return menuState; }, set menuState(value) { menuState = value; },
      get closeMenu() { return closeMenu; },
      get updateModelLabel() { return updateModelLabel; },
      get drawStatus() { return drawStatus; },
      get pid() { return pid; },
      get refresh() { return refresh; },
      get openModelMenu() { return openModelMenu; },
      get openPermMenu() { return openPermMenu; },
      get menuAway() { return menuAway; },
      get attach() { return attach; }, set attach(value) { attach = value; },
      get wouldQueue() { return wouldQueue; },
      get queueFromComposer() { return queueFromComposer; },
      get planState() { return planState; },
      get autosizeBox() { return autosizeBox; },
      get drawAttach() { return drawAttach; },
      get refreshTree() { return refreshTree; },
      get desktop() { return desktop; }, set desktop(value) { desktop = value; },
      get showTab() { return showTab; },
      get ORCH_TASK_KINDS() { return ORCH_TASK_KINDS; },
    });
    var { loadApprovals, onApprovalEvent } = createApprovalEvents({
      get pid() { return pid; },
      get chatId() { return chatId; },
      get desktop() { return desktop; }, set desktop(value) { desktop = value; }
    });
    var { loadFleet, fleetPoll, onFleetEvent, openFleetSheet, closeFleetSheet, drawFleet, drawTeamBlock } = createFleet({
      get desktop() { return desktop; },
      get pid() { return pid; },
      get fleet() { return fleet; },
      get FLEET_KINDS() { return FLEET_KINDS; },
      get orchTerminal() { return orchTerminal; },
      get orchPill() { return orchPill; },
      get mergeOrchRun() { return mergeOrchRun; }
    });

    mount = mount || root;
    clearTimers();
    // Which conversation this view is showing. The daemon streams the whole
    // project over one socket, so the thread filters to this chat itself.
    var chatId = state.currentChat ? state.currentChat() : "main";
    state.chat = chatId;
    // Point state.project at the new project NOW. refresh() below replaces it
    // with the fuller per-project payload, but that lands a fetch later — and
    // everything drawn in the meantime (the Explorer's title above all) would
    // otherwise render the project we just navigated away from.
    state.project = (state.projects || []).filter(function(p){ return p.id === pid; })[0] || null;
    // A chat just created with a chosen agent leaves its pick here, so the
    // composer opens aimed at that agent instead of snapping back to the holder.
    state.pid = pid; state.lastId = 0;
    state.selected = state.pendingSelect || null;
    state.pendingSelect = null;
    state.tab = "thread"; state.tree = null; state.lastQuestion = null;
    var expl = { kids: {}, open: {} }; // explorer tree cache — declared before any drawRail() call
    // Orchestra runs for this project, and which one the view is showing. Up
    // here because the socket and the status poll both reach for it early.
    var orch = { runs: null, active: null, sel: state.pendingOrchRun || null, pinned: !!state.pendingOrchRun, t: null, files: {}, err: "" };
    state.pendingOrchRun = null;
    // Plan mode, remembered per project: the same send, but the agent writes a
    // plan under plans/ instead of code — or, orchestrating, PLAN.md plus a
    // spec per task. Storage can refuse (a private window); the switch still
    // works for this view, it just won't be there after a reload.
    var PLAN_KEY = "loomPlan:" + pid;
    var planState = (function(){ try { return localStorage.getItem(PLAN_KEY) === "1"; } catch (e) { return false; } })();
    // Approvals waiting in this project. Module-scoped (the badge and its list
    // live outside this view), but reset here so another project's never show.
    state.approvals = { pid: pid, list: [] };
    // The Fleet view's reading of /api/activity (declared up here: showTab
    // reaches for its poll during the first paint).
    var fleet = { data: null, err: "", poll: null, t: null };

    var headerActions =
      // Nothing of the agent's lives up here on desktop any more.
      //
      // The theme toggle went to the sidebar foot (a cosmetic switch has no
      // business one pixel from Interrupt) and Interrupt went into the
      // composer. What's left beside the panel toggle is the panel toggle:
      // this strip is about the window, not about the turn.
      (desktop ? "" :
        '<button id="brainbtn" class="iconbtn" title="unified memory">' + ICONS.memory + "</button>" +
        '<button id="treebtn" class="iconbtn" title="working tree">' + ICONS.tree + "</button>" +
        '<button id="routebtn" class="iconbtn" title="routes">' + ICONS.route + "</button>" +
        '<button id="orchbtn" class="iconbtn" title="orchestra">' + ICONS.orchestra + "</button>" +
        '<button id="fleetbtn" class="iconbtn" title="fleet \u00b7 what every agent is doing">' + ICONS.fleet + "</button>" +
        '<button class="apbadge" id="apbadge" type="button" style="display:none"></button>');

    // Send and stop are one button, because they answer the same question — is
    // this turn running? — and it's never both. It belongs where you're already
    // looking when you decide to stop it, not across the window next to a panel
    // toggle. Every chat app does this; so does Antigravity, whose own send
    // swaps to a cancel mid-turn.
    // The composer is a card, not a bare input: a textarea that grows with what
    // you type, a row of controls under it (attach, model), and a place for
    // attachment chips. The @ and / menus mount into #cmenu, positioned over the
    // textarea. #cfile is the hidden file input the paperclip drives.
    var composerHtml =
      '<div class="composer" id="composerwrap"><form class="cbox" id="cform">' +
      '<div class="cmenu" id="cmenu" style="display:none"></div>' +
      '<div class="cchips" id="cchips" style="display:none"></div>' +
      '<div class="cqueue" id="cqueue" style="display:none"></div>' +
      '<textarea id="box" class="cinput" rows="2" placeholder="Message&hellip;  @ for files, / for actions" autocomplete="off"></textarea>' +
      '<div class="cskillsug" id="cskillsug" style="display:none"></div>' +
      '<div class="cpanel" id="cpanel" style="display:none"></div>' +
      // Orchestrate mode's cast: who plans, who works, how many at once.
      // Drawn by drawOrchControls(); hidden in Chat mode.
      '<div class="corch" id="corch" style="display:none"></div>' +
      '<div class="crow">' +
      '<div class="cmode" id="cmode" role="tablist" aria-label="composer mode">' +
      '<button type="button" role="tab" data-cmode="chat" title="talk to one agent">Chat</button>' +
      '<button type="button" role="tab" data-cmode="orch" title="one agent plans, many work in parallel">Orchestrate</button></div>' +
      '<button class="ctool iconly" id="attach" type="button" title="attach an image or file" aria-label="attach a file">' + ICONS.plus + '</button>' +
      '<button class="cagent" id="cagent" type="button" title="who runs this turn \u2014 AUTO routes it, or pick an agent" aria-label="who runs this turn"><span class="cadot" id="cadot"></span><span class="can">agent</span><span class="cchev">' + ICONS.chevron + "</span></button>" +
      // What the chosen agent may do without asking. Drawn by drawPermChip().
      '<button class="cperm" id="cperm" type="button" aria-haspopup="menu" style="display:none"></button>' +
      '<button class="ctool" id="modelpick" type="button" title="pick a model" aria-label="pick a model">' + '<span class="cmodel" id="cmodellabel">model</span>' + '<span class="cchev">' + ICONS.chevron + "</span></button>" +
      '<span class="cdiv"></span>' +
      // MCPs and Skills live behind this rather than beside it: they are
      // occasional settings, and the row they were on has to hold the model,
      // the agent, the permission chip, prompts and send — on a narrow window
      // it wrapped. The count badge stays on the outside, because "two skills
      // are on" is the part you need without opening anything.
      '<button class="cslot" id="morebtn" type="button" aria-haspopup="menu" aria-expanded="false" title="MCPs, skills and more"><span class="cslotico">' + ICONS.dots + '</span><span class="cslotlbl">More</span><span class="skcount" id="skcount" style="display:none">0</span></button>' +
      '<button class="cslot" id="micbtn" type="button" title="hold to talk — needs LOOM_STT_CMD on the daemon"><span class="cslotico">' + ICONS.mic + "</span></button>" +
      // Saved and recent prompts, a clipboard manager's worth (⌘⇧V).
      '<button class="cprompt" id="promptbtn" type="button" aria-haspopup="dialog" title="prompts \u2014 saved and recent (' + KMOD + '\u21e7V)">' +
        ICONS.clipboard + '<span class="cslotlbl">Prompts</span><kbd>' + KMOD + "\u21e7V</kbd></button>" +
      '<span style="flex:1"></span>' +
      // Plan and send travel together: when a narrow row wraps, the switch that
      // changes what send does never ends up a line away from send.
      '<span class="csend">' +
      // Plan: a switch, not a mode tab — it changes what either send does.
      '<button class="cplan" id="planbtn" type="button" role="switch" aria-checked="false" title="plan mode \u2014 write a plan, change no code">' +
        '<span class="ptrack"><i></i></span><span class="cplanlbl">Plan</span></button>' +
      '<button class="sendbtn" id="send" type="submit" title="send">' + ICONS.up + "</button>" +
      '<button class="sendbtn orchsend" id="orchsend" type="button" title="plan this goal and run it in parallel" style="display:none">' + ICONS.orchestra + "Orchestrate</button>" +
      '<button class="sendbtn stopbtn" id="stop" type="button" title="interrupt" aria-label="interrupt" style="display:none">' +
      ICONS.stop + "</button></span>" +
      '</div>' +
      '<input type="file" id="cfile" accept="image/*,.md,.txt,.markdown" multiple style="display:none">' +
      "</form>" +
      '<div class="hint" id="hint"></div></div>';

    if (desktop) {
      mount.innerHTML =
        '<div class="panel">' +
        // Orca chrome: the strip is the window top — context, tabs, actions.
        '<div class="tabstrip" id="tabstrip">' +
        // No project title here. The sidebar already names every project and
        // highlights the open one, so this printed it a second time three
        // inches away — and for a project called "loom" that's the word "loom"
        // twice in one bar, under a window called Loom. Cost and needs-input
        // live on the sidebar row too, so nothing is lost with it.
        '<span id="tabsbox" style="display:contents"></span>' +
        '<span class="spacer"></span>' +
        // Tool calls waiting on you, from any thread of this project.
        '<button class="apbadge" id="apbadge" type="button" style="display:none"></button>' +
        // &#96; is a backtick — a literal one would close this template literal
        '<button id="termbtn" class="iconbtn" title="toggle terminal (\u2303&#96;)">' + ICONS.terminal + "</button>" +
        // Connect a phone: a QR (or copy link) that pairs the native app over the
        // LAN or the tailnet. Sits by the terminal because both are "reach this
        // machine from somewhere else".
        '<button id="phonebtn" class="iconbtn" title="connect a phone" aria-label="connect a phone">' + ICONS.phone + "</button>" +
        // The Console shares the terminal's dock — both are "the drawer at the
        // bottom where output goes", and giving errors their own panel would
        // mean two drawers fighting for the same edge. The dot appears when
        // something has gone wrong since you last looked.
        '<button id="consolebtn" class="iconbtn" title="console \u00b7 errors and logs">' +
        ICONS.console + '<span class="errdot" id="errdot"></span></button>' +
        '<button id="browserbtn" class="iconbtn" title="browser \u00b7 live page and Playwright specs">' + ICONS.globe + "</button>" +
        '<button id="railbtn" class="iconbtn" title="toggle right panel">' + ICONS.panelRight + "</button>" +
        headerActions +
        "</div>" +
        '<div class="paneswrap">' +
        '<div class="mainpane" id="mainpane">' +
        '<div class="pane scroll" id="pane-thread"><div id="agenthead" class="agenthead" style="display:none"></div><div id="routebar"></div><div id="feed">' + LOADER + "</div></div>" +
        '<div class="pane scroll" id="pane-brain" style="display:none">' + LOADER + "</div>" +
        '<div class="pane scroll" id="pane-observatory" style="display:none">' + LOADER + "</div>" +
        '<div class="pane scroll" id="pane-board" style="display:none"></div>' +
        '<div class="pane scroll" id="pane-orchestra" style="display:none"></div>' +
        '<div class="pane scroll" id="pane-fleet" style="display:none"></div>' +
                composerHtml +
        "</div>" +
        '<div class="dockpane" id="dockpane">' +
        '<div class="rz rz-dock" id="rz-dock" title="drag to resize"></div>' +
        '<div class="dockhead" id="dockhead"><span class="di" id="dockicon"></span>' +
        '<span class="p" id="dockpath">changes</span><span class="spacer"></span>' +
        '<button id="dockclose" class="iconbtn" title="close">' + ICONS.x + "</button></div>" +
        '<div class="pane scroll" id="pane-changes">' + LOADER + "</div>" +
        "</div>" +
        "</div>" +
        '<div class="termdock" id="termdock">' +
        '<div class="termresize" id="termresize"></div>' +
        '<div class="termtabs"><span id="termtabs" style="display:contents"></span>' +
        '<button id="termadd" class="iconbtn" title="new terminal">' + ICONS.plus + "</button>" +
        '<span class="spacer"></span>' +
        '<button id="termhide" class="iconbtn" title="hide terminal">' + ICONS.x + "</button></div>" +
        '<div class="termpanes" id="termpanes">' +
        '<div class="conwrap" id="conwrap">' +
        '<div class="conbar">' +
        '<span class="lvl on" data-lvl="all">all</span>' +
        '<span class="lvl" data-lvl="error">errors</span>' +
        '<span class="lvl" data-lvl="warn">warnings</span>' +
        '<select id="conscope" class="consel" title="filter by scope"><option value="">all scopes</option></select>' +
        '<input id="consearch" class="consearch" placeholder="search\u2026" autocomplete="off" spellcheck="false">' +
        '<span class="spacer" style="flex:1"></span>' +
        '<span id="concount"></span>' +
        '<button id="conclear" class="iconbtn" title="clear">' + ICONS.x + "</button>" +
        "</div>" +
        '<div class="conlist" id="conlist"></div>' +
        "</div>" +
        '<div class="browwrap" id="browwrap">' +
        '<div class="browrail">' +
        // The servers this project runs, above its tests: what's up, on which
        // port, and one click to start, stop or look at what it printed.
        '<div class="browbar"><span class="lbl">Dev servers</span><span class="spacer" style="flex:1"></span>' +
        '<button id="srvreload" class="iconbtn xs" title="refresh">' + ICONS.refresh + "</button></div>" +
        '<div class="srvlist" id="srvlist">' + LOADER + "</div>" +
        '<div class="browbar"><span class="lbl">Playwright specs</span><span class="spacer" style="flex:1"></span>' +
        '<button id="specreload" class="iconbtn xs" title="rescan">' + ICONS.refresh + "</button></div>" +
        '<div class="speclist" id="speclist">' + LOADER + "</div>" +
        '<div class="specout" id="specout" style="display:none"></div>' +
        "</div>" +
        '<div class="browmain">' +
        '<div class="browurl">' +
        '<input id="browurl" placeholder="http://localhost:3000 \u2014 preview a dev server" autocomplete="off" spellcheck="false">' +
        '<button id="browgo" class="iconbtn" title="open">' + ICONS.play + "</button>" +
        // The conditions a bug was seen under, and a way to carry the view
        // into the next prompt.
        '<span class="browsizes" id="browsizes">' +
        '<button data-w="0" class="on" title="fit the pane">Fit</button>' +
        '<button data-w="375" title="phone width">375</button>' +
        '<button data-w="768" title="tablet width">768</button>' +
        '<button data-w="1280" title="desktop width">1280</button>' +
        "</span>" +
        // The other half of "the conditions a bug was seen under": the page's
        // colour scheme, independent of Loom's own theme.
        '<span class="browsizes" id="browscheme">' +
        '<button data-s="" class="on" title="whatever your OS is set to">Auto</button>' +
        '<button data-s="light" title="preview the page in light mode">☀</button>' +
        '<button data-s="dark" title="preview the page in dark mode">☽</button>' +
        "</span>" +
        '<button id="browshot" class="iconbtn" title="screenshot into the composer">' + ICONS.camera + "</button>" +
        '<button id="browreload" class="iconbtn" title="reload">' + ICONS.refresh + "</button>" +
        '<label class="browauto" title="reload when an agent changes a file this server serves">' +
        '<input type="checkbox" id="browautorel" checked><span>auto</span></label>' +
        "</div>" +
        '<div class="browframe" id="browframe">' +
        '<div class="browhint">Point this at a running dev server to see the page beside its tests.<br>' +
        "Sites that forbid embedding (X-Frame-Options) won\u2019t render here \u2014 local ones do.</div>" +
        "</div>" +
        // A server's own output, under the page it serves: when the frame goes
        // blank, the reason is usually in here.
        '<div class="srvlog" id="srvlog" style="display:none"><div class="srvlogbar">' +
        '<span class="lbl" id="srvlogname"></span><span class="spacer" style="flex:1"></span>' +
        '<button id="srvlogclose" class="iconbtn xs" title="hide">' + ICONS.x + "</button></div>" +
        '<div class="srvloglines" id="srvloglines"></div></div>' +
        // What the previewed page itself said: its console and its requests,
        // each one a click away from being the next prompt's context.
        '<div class="pglog" id="pglog" style="display:none"><div class="srvlogbar">' +
        '<span class="lbl">Page</span>' +
        '<span class="pgtabs" id="pgtabs"><button data-pg="console" class="on">Console</button>' +
        '<button data-pg="network">Network</button></span>' +
        '<span class="spacer" style="flex:1"></span>' +
        '<span class="pgcount" id="pgcount"></span>' +
        '<button id="pgpick" class="iconbtn xs" title="pick an element on the page">' + ICONS.target + "</button>" +
        '<button id="pgclear" class="iconbtn xs" title="clear">' + ICONS.x + "</button></div>" +
        '<div class="srvloglines" id="pglines"></div></div>' +
        "</div>" +
        "</div></div>" +
        '<form class="terminput" id="termform" style="display:none"><span class="pr">&#10095;</span>' +
        '<input id="terminput" placeholder="run a command\u2026" autocomplete="off" autocapitalize="off" spellcheck="false">' +
        '<span class="st"></span></form>' +
        "</div>" +
        "</div>";
    } else {
      mount.innerHTML =
        '<div class="panel">' +
        "<header>" + '<button id="back" class="iconbtn" title="back">' + ICONS.back + "</button>" +
        '<div class="ptitle"><span class="nm" id="pname">&hellip;</span><span class="st" id="pstat"></span></div>' +
        '<span class="spacer"></span>' + headerActions + "</header>" +
        '<div class="chips" id="chips"></div>' +
        '<div class="scroll" id="pane-thread"><div id="routesheet"></div><div id="routebar"></div><div id="feed">' + LOADER + "</div></div>" +
        composerHtml +
        "</div>";
    }
    bindTheme();
    var backBtn = document.getElementById("back");
    if (backBtn) backBtn.onclick = function(){ location.hash = ""; };
    document.getElementById("stop").onclick = function(){
      api("/api/projects/" + pid + "/interrupt", { method: "POST", body: "{}" })
        .then(function(j){ toast(j.interrupted ? "interrupted " + j.interrupted : "nothing running"); })
        .catch(function(err){ toast(err.message); });
    };
    var apBadge = document.getElementById("apbadge");
    if (apBadge) apBadge.onclick = function(){ openApprovalsPop(apBadge); };
    closeApprovalsPop(); // a list of the last project's requests has no business here

    // ---- desktop tabs (Thread / Tasks / Brain / Routes) --------------------
    // mobile has no #tabsbox, so this is a no-op there by construction
    function drawTabs(){
      var box = document.getElementById("tabsbox"); if (!box) return;
      var tabs = ["thread", "board", "brain", "observatory"];
      // Orchestra sits beside Thread: a run is a conversation that fanned out,
      // and its tasks are threads of their own.
      tabs.splice(1, 0, "orchestra");
      // Fleet sits beside Orchestra: the same question — who is doing what —
      // asked of every agent in every open project, not one run's workers.
      tabs.splice(2, 0, "fleet");
      if (tabs.indexOf(state.tab) < 0) state.tab = "thread";
      var LBL = { thread: [ICONS.thread, "Thread"], orchestra: [ICONS.orchestra, "Orchestra"], fleet: [ICONS.fleet, "Fleet"], board: [ICONS.board, "Board"],
                  brain: [ICONS.memory, "Brain"], observatory: [ICONS.telescope, "Observatory"] };
      box.innerHTML = tabs.map(function(tb){
        return '<button class="tab' + (state.tab === tb ? " active" : "") + '" data-tab="' + tb + '">' +
          LBL[tb][0] + LBL[tb][1] + (tb === "orchestra" ? '<span class="tdot" id="orchtdot" style="display:none"></span>' : "") + "</button>";
      }).join("");
      Array.prototype.forEach.call(box.querySelectorAll(".tab"), function(tb){
        tb.onclick = function(){ showTab(tb.getAttribute("data-tab")); };
      });
    }
    function showTab(name){
      state.tab = name;
      ["thread", "orchestra", "fleet", "board", "brain", "observatory"].forEach(function(t){
        var p = document.getElementById("pane-" + t);
        if (p) p.style.display = t === name ? "" : "none";
      });
      var strip = document.getElementById("tabstrip");
      if (strip) Array.prototype.forEach.call(strip.querySelectorAll(".tab"), function(tb){
        tb.classList.toggle("active", tb.getAttribute("data-tab") === name);
      });
      var cw = document.getElementById("composerwrap");
      if (cw) cw.style.display = name === "thread" ? "" : "none";
      if (name === "brain") refreshBrain();
      // first open fetches; later opens keep the board (and your pins)
      if (name === "board") { if (board.data) drawBoardPane(); else loadBoard(); }
      if (name === "observatory") drawObservatory();
      if (name === "orchestra") { drawOrch(); loadOrch(); }
      // Fleet polls only while you can see it.
      if (name === "fleet") { drawFleet(); loadFleet(); loadTeam(); }
      fleetPoll(name === "fleet");
      if (name === "thread") {
        var sc = document.getElementById("pane-thread");
        if (sc) sc.scrollTop = sc.scrollHeight;
      }
    }

    // ---- Observatory: the fleet in action, the one brain -------------------
    // A live canvas of every agent as a node linked to the shared brain, the
    // baton drawn in shuttle, plus fleet metrics — the same numbers Loom ships
    // as gen_ai spans over OTLP. Kept dependency-free, rendered from strings.
    var obNodePos = {};        // agent id -> {x,y} once dragged, persists across redraws
    var obRefreshT = null;
    var OBS_LIVE_KINDS = { run_complete: 1, handoff: 1, status: 1, route_started: 1,
      route_completed: 1, route_failed: 1, agent_join: 1, agent_leave: 1, needs_input: 1 };

    // ---- Ask — the fleet's own telemetry, asked in English --------------
    // Backed by POST /observatory/ask, which assembles the evidence from the
    // same sources this screen renders (status, metrics, health, spans,
    // decisions) and hands any configured telemetry MCP server to the model. So an
    // answer can only ever cite numbers that are also on the screen.
    var ASK_SUGGESTIONS = [
      "Which agent is costing me the most, and why?",
      "Is anything unhealthy right now?",
      "What did the fleet decide so far?",
      "Where did the baton spend most of its time?",
      "Show me the slowest turns and what they were doing."
    ];

    // ---- Dashboard charts ---------------------------------------------------
    // Donuts for composition ("what is the spend made of"), lines for behaviour
    // over time. Every value here comes from /metrics byAgent or the real event
    // log — there is no sample data path, so an empty fleet draws an empty state
    // rather than a decorative shape.
    var OBPAL = ["var(--ch1)", "var(--ch2)", "var(--ch3)", "var(--ch4)", "var(--ch5)", "var(--ch6)"];

    // ---- review comments: click a diff line, say what's wrong ---------------
    // Comments stage locally and leave as ONE message through the composer, so
    // the reply goes to whichever agent you pick there — same contract as
    // every other send, no parallel channel to a special endpoint.
    if (!state.review) state.review = [];
    if (desktop) {
      document.getElementById("dockclose").onclick = closeDock;
      document.getElementById("railbtn").onclick = toggleRail;
      // The terminal button wants the terminal. If the console tab is the active
      // pane, switch to a terminal rather than closing the dock out from under it.
      document.getElementById("termbtn").onclick = function(){
        var opening = !termOpen();
        toggleTerm(); // flips the dock; applyTerm ensures a terminal when opening
        if (opening && activeTerm === CONSOLE_TAB) {
          activeTerm = terms.length ? terms[terms.length - 1].id : null;
          drawTermTabs(); showTermPane(); focusTerm();
        }
      };
      bindConsole();
      var bwb = document.getElementById("browserbtn");
      if (bwb) bwb.onclick = function(){
        (state.browserActive && state.browserActive()) ? closeBrowser() : openBrowser();
      };
      var phb = document.getElementById("phonebtn");
      if (phb) phb.onclick = openConnectPhone;
      if (!state.railView) state.railView = localStorage.getItem("loomRailView") || "explorer";
      applyRail();
      var dockEl = document.getElementById("dockpane");
      var savedDock = Number(localStorage.getItem("loomDockW"));
      if (savedDock) dockEl.style.width = savedDock + "px";
      makeResizer("rz-dock", {
        get: function(){ return dockEl.offsetWidth; },
        set: function(w){ dockEl.style.width = w + "px"; },
        min: 280,
        max: function(){
          var wrap = document.querySelector(".paneswrap");
          return Math.max(320, (wrap ? wrap.offsetWidth : window.innerWidth) - 380);
        },
        def: 520, key: "loomDockW", invert: true,
      });
      drawTabs();
      showTab("thread");
      // A just-launched orchestra lands on its own view, in its own chat.
      if (state.pendingTab) { var pt = state.pendingTab; state.pendingTab = null; showTab(pt); }
      drawRail();
    }

    // ---- terminal dock -----------------------------------------------------
    // Two backends, chosen by the daemon (see terminals.ts). With a real pty
    // we hand the bytes to xterm.js and get a true terminal; without one we
    // drive a line at a time and render it ourselves.
    var TERM_KEY = "loomTerm";
    var terms = [], activeTerm = null, termSeq = 0, termMode = null;
    // The console is a pseudo-tab in the terminal dock's tab bar: it shares the
    // dock and the pane area, and is switched to like any terminal. This
    // sentinel is its "id" for activeTerm.
    var CONSOLE_TAB = "__console__";
    var BROWSER_TAB = "__browser__";
    state.showConsole = showConsolePane;
    state.hideConsole = hideConsolePane;
    state.consoleActive = function(){ return activeTerm === CONSOLE_TAB; };
    state.redrawTermTabs = drawTermTabs;
    state.showBrowser = showBrowserPane;
    state.hideBrowser = hideBrowserPane;
    state.browserActive = function(){ return activeTerm === BROWSER_TAB; };
    if (desktop) {
      document.getElementById("termhide").onclick = function(){ localStorage.setItem(TERM_KEY, "0"); applyTerm(); };
      document.getElementById("termadd").onclick = function(){ addTerm(); };
      var tin = document.getElementById("terminput");
      tin.addEventListener("keydown", function(e){
        var t = curTerm(); if (!t) return;
        if (e.ctrlKey && (e.key === "c" || e.key === "C")) {
          if (!String(window.getSelection() || "")) { e.preventDefault(); interruptTerm(); }
          return;
        }
        if (e.ctrlKey && (e.key === "l" || e.key === "L")) {
          e.preventDefault(); t.html = ""; t.ansi = { cls: [] }; if (t.body) t.body.innerHTML = ""; return;
        }
        if (e.key === "ArrowUp") {
          if (!t.hist.length) return;
          e.preventDefault();
          if (t.hi === -1) { t.draft = this.value; t.hi = t.hist.length - 1; }
          else if (t.hi > 0) t.hi--;
          this.value = t.hist[t.hi];
          return;
        }
        if (e.key === "ArrowDown") {
          if (t.hi === -1) return;
          e.preventDefault();
          if (t.hi < t.hist.length - 1) { t.hi++; this.value = t.hist[t.hi]; }
          else { t.hi = -1; this.value = t.draft || ""; }
        }
      });
      document.getElementById("termform").addEventListener("submit", function(ev){
        ev.preventDefault();
        var inp = document.getElementById("terminput");
        var cmd = (inp.value || "").trim();
        var t = curTerm();
        inp.value = "";
        if (t) { t.hi = -1; t.draft = ""; }
        if (!cmd || !t) return;
        if (t.hist[t.hist.length - 1] !== cmd) t.hist.push(cmd);
        if (cmd === "clear") { t.html = ""; t.ansi = { cls: [] }; if (t.body) t.body.innerHTML = ""; return; }
        runCmd(cmd);
      });
      var rz = document.getElementById("termresize");
      rz.addEventListener("mousedown", function(ev){
        ev.preventDefault();
        var dock = document.getElementById("termdock");
        var startY = ev.clientY, startH = dock.offsetHeight;
        document.body.classList.add("resizing-x");
        function mv(e){
          dock.style.height = Math.max(110, Math.min(window.innerHeight * 0.7, startH + (startY - e.clientY))) + "px";
          fitActive();
        }
        function up(){
          document.body.classList.remove("resizing-x");
          localStorage.setItem("loomTermH", String(dock.offsetHeight));
          fitActive();
          document.removeEventListener("mousemove", mv); document.removeEventListener("mouseup", up);
        }
        document.addEventListener("mousemove", mv); document.addEventListener("mouseup", up);
      });
      var savedH = Number(localStorage.getItem("loomTermH"));
      if (savedH) document.getElementById("termdock").style.height = savedH + "px";
      window.addEventListener("resize", fitActive);
      state.toggleTerm = toggleTerm;
      state.retheme = function(){
        terms.forEach(function(t){ if (t.xterm) t.xterm.options.theme = xtermTheme(); });
      };
      // Run a command in the terminal, opening the dock (and a shell) first if
      // need be — the palette's "cd into a worktree" and the status bar's
      // "Connect GitHub" both drive gh/git through the real terminal you already
      // have, rather than reimplementing an interactive login.
      state.termRun = function(cmd){
        var live = termOpen() && curTerm();
        if (!termOpen()) toggleTerm(); else ensureTerm();
        var fire = function(){
          var t = curTerm(); if (!t) return;
          if (t.xterm) {
            // pty: type the line and press Enter (\r); the shell runs it
            api("/api/projects/" + pid + "/term/input",
                { method: "POST", body: JSON.stringify({ term: t.id, data: cmd + "\r" }) }).catch(function(){});
          } else {
            runCmd(cmd); // pipe-backed shell: one command per line
          }
          focusTerm();
        };
        // a shell we just spawned needs a beat before it will accept input
        if (live) fire(); else setTimeout(fire, 650);
      };
      // NB: applyTerm() runs after connect() below — opening a shell before
      // the socket is listening broadcasts its prompt to nobody.
      state.startTerminals = applyTerm;
    }

    // click an Update(…) card in the thread → open its diff on the right
    // (desktop dock); on mobile, expand it inline.
    document.getElementById("feed").addEventListener("click", function(ev){
      // An agent's question, answered in place. First: the card lives inside
      // the feed, and its input must not read as a click on the card behind it.
      if (needsInputClick(ev)) return;
      // A code block's copy button, because it lives inside cards that claim
      // clicks of their own (a turn card opens its diff, a details folds).
      // Rewind, before the turn card's own click — the button sits inside the
      // card, and opening a diff dock instead of asking would be a surprise.
      var rw = ev.target.closest && ev.target.closest("[data-rewind]");
      if (rw) { ev.preventDefault(); ev.stopPropagation(); askRewind(rw.getAttribute("data-rewind"), rw); return; }
      var go = ev.target.closest && ev.target.closest("[data-gochat]");
      if (go) { ev.preventDefault(); openOrchChat(go.getAttribute("data-gochat")); return; }
      var cp = ev.target.closest && ev.target.closest(".mdcopy");
      if (cp) {
        ev.preventDefault(); ev.stopPropagation();
        var box = cp.parentNode && cp.parentNode.querySelector("code");
        if (box) copyText(box.textContent || "");
        return;
      }
      var ap = ev.target.closest && ev.target.closest("[data-orch-apply]");
      if (ap) { applyOrch(ap.getAttribute("data-orch-apply"), ap); return; }
      var rd = ev.target.closest && ev.target.closest("[data-orch-deliver]");
      if (rd) { redeliverOrch(rd.getAttribute("data-orch-deliver"), rd); return; }
      if (approvalClick(ev)) return;
      if (ev.target.closest && ev.target.closest(".apcard")) return; // the card's own input, its details
      var t = ev.target;
      while (t && t !== this && !(t.classList && t.classList.contains("turncard"))) t = t.parentNode;
      if (!t || t === this) return;
      if (ev.target.closest && ev.target.closest(".tcdiff")) return; // let diff text select/scroll
      var enc = t.getAttribute("data-patch"); if (!enc) return;
      var patch = decodeURIComponent(enc);
      if (desktop) { openPatchDock(patch, t.getAttribute("data-label") || "changes"); return; }
      var d = t.querySelector(".tcdiff"); if (!d) return;
      var open = d.style.display !== "none" && d.innerHTML;
      if (open) { d.style.display = "none"; }
      else {
        if (!d.innerHTML) d.innerHTML = '<div class="dcode">' + renderDiffLines(patch.split("\n")) + "</div>";
        d.style.display = "";
      }
      var ch = t.querySelector(".tchev");
      if (ch) ch.textContent = open ? "\u25b8" : "\u25be";
    });
    document.getElementById("feed").addEventListener("keydown", approvalKey);
    // Enter in an answer box sends it, the way Enter sends anywhere else.
    document.getElementById("feed").addEventListener("keydown", function(ev){
      if (ev.key !== "Enter" || !ev.target.classList || !ev.target.classList.contains("nitext")) return;
      ev.preventDefault();
      answerAgent(ev.target.closest(".nicard"), ev.target.value);
    });

    // ---- working tree (feeds the Source Control rail view) -----------------
    function refreshTree(force){
      api("/api/projects/" + pid + "/tree").then(function(j){
        state.tree = j.tree || {};
        if (state.railView === "scm") drawRail();
      }).catch(function(err){ if (force) toast(err.message); });
    }

    // ---- brain pane ---------------------------------------------------------
    // Which kind of memory the Brain tab is filtered to ("" = all).
    var brainKind = "";
    var BRAIN_KINDS = ["constraint", "failure", "decision", "convention", "fact", "task"];

    // ---- brain pane · Team view (Phase 3: one brain) -------------------------
    // Mine is this machine's brain, above. Team is the team's: canon from
    // AGENTS.md, what teammates learned, by tier, and an inbox of what needs a
    // human first. Every action answers with the fresh view, so no re-read.
    var brainView = "mine", tbHistory = false, tbPr = null, tbPingT = null;
    var TB_TIERS = [["canon", "Canon"], ["confirmed", "Confirmed"], ["own", "Yours"], ["proposed", "Proposed"]];
    // A teammate's memory or a resolution landed: re-read, once per burst.
    state.teamBrainPing = function(){
      if (state.tab !== "brain" || brainView !== "team" || tbPingT) return;
      tbPingT = setTimeout(function(){ tbPingT = null; if (brainView === "team") refreshTeamBrain(); }, 600);
    };
    // ---- board pane ---------------------------------------------------------
    // Cards are derived from live state (see board.ts): which agents are
    // running or blocked, and what GitHub says about each PR. Nothing here is
    // stored except your pins.
    var board = { data: null, loading: false, pins: null, q: "",
                  // GitHub | Projects (GH Projects v2) | Linear — one board, three sources
                  source: "github",
                  ghProjects: null, ghProject: null, ghItems: null, ghItemsLoading: false,
                  linear: null, linearTeams: null, linearLoading: false };
    var BCOLS = [
      ["working", "Working", "var(--warn)"],
      ["needs-you", "Needs you", "var(--warn)"],
      ["in-review", "In review", "var(--muted-foreground)"],
      ["ready", "Ready to merge", "var(--ok)"],
    ];
    // your card's badge follows the column you put it in — mirrors board.ts
    var OWN_STATE = { "working": "working", "needs-you": "input-needed",
                      "in-review": "review-pending", "ready": "ready" };
    var BSTATES = {
      "working": ["Working", "var(--warn)"],
      "input-needed": ["Input needed", "var(--warn)"],
      "issue": ["Open issue", "var(--thread-ink)"],
      "ci-failed": ["CI failed", "var(--err)"],
      "changes-requested": ["Changes requested", "var(--warn)"],
      "review-pending": ["Review pending", "var(--muted-foreground)"],
      "draft": ["Draft PR", "var(--muted-foreground)"],
      "approved": ["Approved", "var(--ok)"],
      "ready": ["Ready", "var(--ok)"],
    };
    var PINKEY = "loomBoardPins:" + pid;

    // ---- mobile sheets -------------------------------------------------------
    var brainOpen = false, treeOpen = false, sheetOpen = false;
    if (!desktop) {
      document.getElementById("brainbtn").onclick = function(){
        brainOpen = !brainOpen; treeOpen = false;
        var el = document.getElementById("routesheet");
        if (!brainOpen) { el.innerHTML = ""; return; }
        el.innerHTML = '<div class="sheet"><label>unified memory</label>' + LOADER + "</div>";
        api("/api/projects/" + pid + "/memory").then(function(j){
          if (!brainOpen) return;
          var m = j.memory || {};
          var head = "<label>one brain &middot; " + (m.sources || []).length +
            " ADE source(s) &middot; " + (m.decisions || []).length + " decision(s)</label>";
          var src = (m.sources || []).map(function(s){
            return '<div class="tool">' + esc(s.agentId) + " \u2190 " + esc(s.file) + "</div>";
          }).join("");
          var body = esc(m.document || "").split("\n").map(function(line){
            var c = line.charAt(0) === "#" ? "var(--foreground)" : "var(--muted-foreground)";
            return '<div style="color:' + c + ';white-space:pre-wrap;word-break:break-word;font-size:12px;font-family:var(--font-mono)">' + (line || " ") + "</div>";
          }).join("");
          el.innerHTML = '<div class="sheet">' + head + src +
            '<div class="scrollable" style="max-height:46vh;overflow:auto;border-top:1px solid var(--border);padding-top:8px">' + body + "</div>" +
            '<button class="btn primary" id="reimport">re-import ADE memory</button></div>';
          document.getElementById("reimport").onclick = function(){
            api("/api/projects/" + pid + "/memory/import", { method: "POST", body: "{}" })
              .then(function(r){ toast(r.imported ? "imported " + r.imported + " source(s)" : "brain already current"); brainOpen = false; document.getElementById("brainbtn").click(); })
              .catch(function(err){ toast(err.message); });
          };
        }).catch(function(err){ toast(err.message); });
      };
      document.getElementById("treebtn").onclick = function(){
        treeOpen = !treeOpen; brainOpen = false;
        var el = document.getElementById("routesheet");
        if (!treeOpen) { el.innerHTML = ""; return; }
        el.innerHTML = '<div class="sheet"><label>working tree</label>' + LOADER + "</div>";
        api("/api/projects/" + pid + "/tree").then(function(j){
          if (!treeOpen) return;
          var t = j.tree || {};
          if (!t.git) { el.innerHTML = '<div class="sheet"><label>working tree</label><div class="sys">not a git repository</div></div>'; return; }
          var head = "<label>working tree &middot; " + esc(t.branch || "") + " &middot; " +
            (t.files || []).length + " changed</label>";
          var list = (t.files || []).map(function(f){
            return '<div class="tool">' + esc(f.status) + " " + esc(f.path) + "</div>";
          }).join("");
          var patch = (t.patch || "").split("\n").map(function(line){
            var c = line.charAt(0) === "+" ? "var(--git-add)" : line.charAt(0) === "-" ? "var(--git-del)" : "var(--muted-foreground)";
            return '<div style="color:' + c + ';white-space:pre-wrap;word-break:break-all">' + esc(line) + "</div>";
          }).join("");
          el.innerHTML = '<div class="sheet">' + head + list +
            '<div class="scrollable" style="font-family:var(--font-mono);font-size:11px;max-height:40vh;overflow:auto;border-top:1px solid var(--border);padding-top:8px">' +
            (patch || '<div class="sys">clean</div>') + "</div></div>";
        }).catch(function(err){ toast(err.message); });
      };
      document.getElementById("routebtn").onclick = function(){
        sheetOpen = !sheetOpen; treeOpen = false; brainOpen = false;
        var el = document.getElementById("routesheet"); if (!el) return;
        if (!sheetOpen) { el.innerHTML = ""; return; }
        el.innerHTML = '<div class="sheet">' + routeFormHtml() + "</div>";
        bindRouteForm(function(){ sheetOpen = false; document.getElementById("routesheet").innerHTML = ""; });
      };
      // The phone has no tab strip, so the Orchestra view is a sheet — the
      // same drawing as the desktop tab, in the same slot as its siblings.
      document.getElementById("orchbtn").onclick = function(){
        if (document.getElementById("orchsheet")) { closeOrchSheet(); return; }
        openOrchSheet();
      };
      // Fleet the same way: the desktop tab's drawing, in the sheet slot.
      document.getElementById("fleetbtn").onclick = function(){
        if (document.getElementById("fleetsheet")) { closeFleetSheet(); return; }
        openFleetSheet();
      };
    }
    state.refreshExplorer = function(){
      expl.kids = {}; // keep folders open, re-read their contents
      var open = Object.keys(expl.open).filter(function(k){ return expl.open[k]; });
      drawExplorer(document.getElementById("railbody"));
      open.forEach(function(d){ loadDir(d); });
    };
    // Actions the module-level command palette (and status bar) drive back in.
    state.openFile = openFileFromTree;
    state.showTab = showTab;
    state.reloadBoard = loadBoard;
    state.showRail = function(view){ state.railView = view; drawRail(); };
    state.selectAgent = function(id){
      if (!id) return;
      state.selected = id;
      drawStatus();
      showTab("thread");
      var b = document.getElementById("box"); if (b) b.focus();
    };
    state.drawRail = drawRail;

    // Live frames that race the history fetch wait their turn, so an early
    // WS event can't outrun (and id-mask) the backlog.
    var historyLoaded = false, pendingWs = [];
    // The transcript-level menu lives in the shell's scope, and this doesn't.
    state.redrawFeed = loadHistory;
    loadHistory();
    refresh();
    state.timers.push(setInterval(refresh, 4000));
    if (desktop) {
      refreshTree(false);
      state.timers.push(setInterval(function(){ refreshTree(false); }, 5000));
    }
    connect();

    // Attachments live here for the life of this project view. A pasted image
    // or dropped file is uploaded to .loom/attachments/ and referenced by path
    // in the outgoing message — the CLIs take text, not blobs, so the path IS
    // the attachment. Cleared after each send.
    var attach = [];

    // ---- the prompt queue --------------------------------------------------
    // What you've lined up while something else is running. Yours until it's
    // sent: edit the text, change who takes it, reorder it, drop it. The
    // daemon sends the head as soon as nothing is in its way, one at a time.

    var queue = { items: [], paused: false, reason: "", waitingFor: "", editing: null, dragging: null };

    // The @ / popover. menuState remembers what kind of menu is open and where
    // in the text the trigger started, so accepting an item replaces exactly the
    // token you were typing.
    var menuState = null;

    // ---- prompt manager ------------------------------------------------------
    // A clipboard manager for prompts: what you saved (pinned first, then by
    // use) above everything you've actually sent (newest first). Daemon-wide —
    // a prompt you wrote in one project is there in the next. Opens from the
    // chip or ⌘⇧V / Ctrl+Shift+V; ↑↓ move, Enter inserts, ⌘Enter inserts and
    // sends — in Chat or Orchestrate, because send() already knows which.
    var prompts = { saved: [], recent: [], q: "", sel: 0, rows: [], loaded: false };
    var MCPMARK = {
      github: '<path d="M12 1.3a10.7 10.7 0 0 0-3.4 20.9c.5.1.7-.2.7-.5v-2c-3 .6-3.6-1.3-3.6-1.3-.5-1.2-1.2-1.6-1.2-1.6-1-.7.1-.7.1-.7 1.1.1 1.6 1.1 1.6 1.1 1 1.7 2.6 1.2 3.2.9.1-.7.4-1.2.7-1.5-2.4-.3-4.9-1.2-4.9-5.4 0-1.2.4-2.1 1.1-2.9-.1-.3-.5-1.4.1-2.9 0 0 .9-.3 3 1.1a10.3 10.3 0 0 1 5.5 0c2.1-1.4 3-1.1 3-1.1.6 1.5.2 2.6.1 2.9.7.8 1.1 1.7 1.1 2.9 0 4.2-2.5 5.1-4.9 5.4.4.3.7 1 .7 2v3c0 .3.2.6.7.5A10.7 10.7 0 0 0 12 1.3Z"/>',
      linear: '<path d="M2.2 13.6 10.4 21.8a10 10 0 0 1-8.2-8.2Zm-.2-2.5 11 10.9c.7-.1 1.4-.3 2-.5L2.4 9.1c-.2.6-.3 1.3-.4 2Zm1.2-3.6 12.3 12.3c.5-.3 1-.6 1.4-.9L4.1 6.2c-.4.4-.6.9-.9 1.3Zm2-2.6L18.9 18.9A10 10 0 0 0 5.2 5Z"/>',
      slack: '<path d="M5.1 14.5a2.1 2.1 0 1 1-2.1-2.1h2.1v2.1Zm1 0a2.1 2.1 0 0 1 4.2 0v5.3a2.1 2.1 0 0 1-4.2 0v-5.3ZM8.2 5a2.1 2.1 0 1 1 2.1-2.1v2.1H8.2Zm0 1a2.1 2.1 0 0 1 0 4.2H2.9a2.1 2.1 0 0 1 0-4.2h5.3ZM17.7 8.2a2.1 2.1 0 1 1 2.1 2.1h-2.1V8.2Zm-1 0a2.1 2.1 0 1 1-4.2 0V2.9a2.1 2.1 0 0 1 4.2 0v5.3ZM14.5 17.7a2.1 2.1 0 1 1-2.1 2.1v-2.1h2.1Zm0-1a2.1 2.1 0 0 1 0-4.2h5.3a2.1 2.1 0 0 1 0 4.2h-5.3Z"/>',
      notion: '<path d="M4.4 3.3 15.9 2.4c1.4-.1 1.8-.1 2.7.6l3 2.1c.6.4.8.5.8 1v13.3c0 .9-.3 1.4-1.5 1.5l-13.3.8c-.8 0-1.2-.1-1.7-.7L3.1 18c-.5-.7-.7-1.2-.7-1.8V4.8c0-.7.3-1.3 2-1.5Zm11.9 1.4L5.2 5.5c-.6 0-.7.3-.5.5l1.9 1.4c.3.2.6.5 1.2.4l10.7-.6c.3 0 .1-.3-.1-.4l-1.6-1.2c-.2-.2-.5-.4-1-.4Zm-1.6 4.5-11 .6v10.9c0 .6.3.8 1 .8l10.5-.6c.6 0 .7-.4.7-.9V9.6c0-.5-.2-.7-.7-.7Z"/>',
      sentry: '<path d="M13.2 2.6a2.4 2.4 0 0 0-4.2 0L6.8 6.4a17 17 0 0 1 8.6 13.5h-2.5A14.5 14.5 0 0 0 5.6 8.5L3.4 12.3a10 10 0 0 1 4.8 7.6H3.5c-.4 0-.6-.4-.4-.7l1.3-2.2a6.7 6.7 0 0 0-1.4-.9l-1.3 2.2A2.4 2.4 0 0 0 3.5 22h6.8a12 12 0 0 0-4.9-10.4l1-1.7a14 14 0 0 1 5.6 12.1h5.5a2.4 2.4 0 0 0 2-3.6Z"/>',
      stripe: '<path d="M11.3 9.9c0-.8.7-1.1 1.7-1.1 1.5 0 3.4.5 4.9 1.3V5.5a13 13 0 0 0-4.9-.9c-4 0-6.7 2.1-6.7 5.6 0 5.4 7.5 4.6 7.5 6.9 0 .9-.8 1.2-1.9 1.2-1.6 0-3.8-.7-5.4-1.6v4.7c1.8.8 3.6 1.1 5.4 1.1 4.1 0 6.9-2 6.9-5.6 0-5.9-7.5-4.9-7.5-7.1Z"/>',
      supabase: '<path d="M13.8 22.3c-.6.8-1.9.4-1.9-.6l-.3-8.2h5.5c1 0 1.6 1.2 1 2l-4.3 6.8ZM10.2 1.7c.6-.8 1.9-.4 1.9.6l.3 8.2H6.9c-1 0-1.6-1.2-1-2l4.3-6.8Z"/>',
      figma: '<path d="M8.5 22a3.5 3.5 0 0 0 3.5-3.5V15H8.5a3.5 3.5 0 0 0 0 7Zm0-7.5H12V8H8.5a3.25 3.25 0 0 0 0 6.5ZM12 8h3.5a3.25 3.25 0 0 0 0-6.5H12V8Zm-3.5 0H12V1.5H8.5a3.25 3.25 0 0 0 0 6.5Zm7 6.5a3.25 3.25 0 1 0 0-6.5 3.25 3.25 0 0 0 0 6.5Z"/>',
      cloudflare: '<path d="M16.5 16.3c.2-.6.1-1.1-.2-1.5-.3-.4-.8-.6-1.4-.6l-10.5-.1c-.1 0-.1 0-.2-.1v-.2c0-.1.1-.2.2-.2l10.6-.1c1.3 0 2.6-1 3.1-2.3l.6-1.5v-.2a5.9 5.9 0 0 0-11.3-.6 2.7 2.7 0 0 0-4.2 2.6A3.8 3.8 0 0 0 0 15.4c0 .2 0 .4.1.6 0 .1.1.2.2.2h15.6c.1 0 .2-.1.3-.2l.3.3Zm2.9-6.4h-.3c-.1 0-.1.1-.2.2l-.4 1.4c-.2.6-.1 1.1.2 1.5.3.4.8.6 1.4.6l2.2.1c.1 0 .1 0 .2.1v.2c0 .1-.1.2-.2.2l-2.3.1c-1.3 0-2.6 1-3.1 2.3l-.2.5c0 .1 0 .2.1.2h7.9c.1 0 .2-.1.2-.2.1-.5.2-1.1.2-1.6a5 5 0 0 0-5-5Z"/>',
      playwright: '<path d="M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm-3.7 7.4c.9 0 1.6.7 1.6 1.6H6.7c0-.9.7-1.6 1.6-1.6Zm7.4 0c.9 0 1.6.7 1.6 1.6h-3.2c0-.9.7-1.6 1.6-1.6ZM12 18.2a5.6 5.6 0 0 1-5.3-3.7h10.6a5.6 5.6 0 0 1-5.3 3.7Z"/>',
      postgres: '<path d="M17.4 2.6c-1.6-.4-3.3-.5-4.9-.2-.6-.2-1.2-.3-1.8-.3-1.2 0-2.3.3-3.3.9-1-.4-3.6-1.2-5 .3C1.2 4.6 1.5 8 2.7 12.6c.6 2.3 1.4 4.3 2.2 5.6.4.6 1 1.4 1.9 1.5.6.1 1.2-.2 1.8-.8.6.2 1.3.3 2 .3h.1c.7 0 1.3-.1 1.9-.3.4.4.9.7 1.5.8h.4c1.1 0 1.9-.8 2.5-1.8 1.2-2 1.9-5.9 2-7.3.2-1.9 0-5.5-1.6-7.4-.2-.3-.6-.5-1-.6ZM8.4 7.6c-.1.9.1 1.7.4 2.4.3.9.5 1.6-.1 2.5-.6-1.4-.9-3.4-.6-4.9Zm7.3 8.7c-.5.9-.9 1.1-1.1 1.1-.4 0-.8-.5-1-.9.7-1.1.9-2.4.9-2.5v-.4c0-.2-.1-.3-.3-.4-.5-.2-1.2-.1-1.7.1.2-.9.7-1.6 1.5-2.1 1.3 1.2 2 2.8 2.2 3.9-.1.5-.3 1-.5 1.2Z"/>',
      signoz: '<path d="M12 2 3 7v10l9 5 9-5V7l-9-5Zm0 2.3 6.8 3.8L12 11.9 5.2 8.1 12 4.3ZM5 9.8l6 3.4v6.8l-6-3.3V9.8Zm8 10.2v-6.8l6-3.4v6.9l-6 3.3Z"/>',
      filesystem: '<path d="M10 4H4a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-8l-2-2Z"/>'
    };
    var _sugT = null;
    state.setComposerMode = setComposerMode;
    // Worker events that change what a card says; the rest (every tool call,
    // every streamed line) would only refetch an unchanged run.
    var ORCH_TASK_KINDS = { run_complete: 1, file_edit: 1, error: 1, needs_input: 1, turn_diff: 1 };
    // The team view landed or changed: goal titles on hold banners may have too.
    teamHooks().orch = function(){
      if (state.pid !== pid) return;
      var el = orchEl(), run = orch.runs && (findOrchRun(orch.sel) || orch.runs[0]);
      var names = run && (run.tasks || []).some(function(t){ return (t.hold && t.hold.runId) || /^wait:/.test(t.overlap || ""); });
      if (el && names && !teamEditing(el)) drawOrch();
    };
    loadOrch();
    loadApprovals();
    // Events that change a Fleet row; a burst (a plan spawning five tasks)
    // coalesces into one fetch.
    var FLEET_KINDS = { run_complete: 1, handoff: 1, status: 1, tool_call: 1, file_edit: 1, message: 1, orchestra: 1, approval: 1,
      needs_input: 1, error: 1, agent_join: 1, agent_leave: 1, subtask_started: 1, subtask_done: 1, subtask_failed: 1,
      route_started: 1, route_step: 1, route_completed: 1, route_failed: 1 };
    teamHooks().fleet = function(force){ if (state.pid === pid) drawTeamBlock(force); };
    // Phase 5: this project's runners, read once per view — they decide whether
    // the composer offers "Run on" and a run card offers "Continue on runner".
    runnerHooks.orch = function(p){
      if (p !== pid || state.pid !== pid) return;
      var el = orchEl();
      if (el && orch.runs && !teamEditing(el)) drawOrch();
      drawOrchControls();
    };
    loadTeamRunners(pid, true);

    // Git delivery lives in the status bar, which only the desktop shell has.
    if (desktop) loadGitDelivery(pid);

    // Explicit bridge for shell/preview actions into this mounted composer.
    // Identity is checked by asynchronous callers before delivering a result.
    state.composer = {
      projectId: pid,
      autosize: autosizeBox,
      refresh: refresh,
      addAttachment: function(item) { attach.push(item); drawAttach(); }
    };
    bindComposer();
    loadQueue();
    maybeDigest(pid);
  }
export { renderProject };
