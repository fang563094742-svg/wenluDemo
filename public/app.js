/**
 * 问路前端 — 极致美学交互版
 * 打字机效果 / textarea 自适应 / 任务面板展开收起 / 气泡动效 / 滚动阴影
 */
(function () {
  "use strict";

  var chat = document.getElementById("chat");
  var input = document.getElementById("input");
  var sendBtn = document.getElementById("send-btn");
  var inputWrap = document.getElementById("input-wrap");
  var cyclesEl = document.getElementById("cycles");
  var understandingEl = document.getElementById("understanding-preview");
  var tasksListEl = document.getElementById("tasks-list");
  var taskCountEl = document.getElementById("task-count");
  var tasksBadgeEl = document.getElementById("tasks-badge");
  var connStatusEl = document.getElementById("conn-status");
  var topbar = document.getElementById("topbar");
  var tasksPanel = document.getElementById("tasks-panel");
  var tasksToggle = document.getElementById("tasks-toggle");
  var tasksClose = document.getElementById("tasks-close");
  var thinkingEl = null;
  var stateSummaryEl = document.getElementById("state-summary");
  var nextActionsEl = document.getElementById("next-actions");

  // --- Textarea 自适应高度 ---
  function autoResize() {
    input.style.height = "24px";
    input.style.height = Math.min(input.scrollHeight, 120) + "px";
  }

  input.addEventListener("input", function () {
    autoResize();
    updateSendBtn();
  });

  function updateSendBtn() {
    if (input.value.trim()) {
      sendBtn.classList.add("active");
    } else {
      sendBtn.classList.remove("active");
    }
  }

  // --- 滚动时顶栏阴影 ---
  chat.addEventListener("scroll", function () {
    if (chat.scrollTop > 10) {
      topbar.classList.add("scrolled");
    } else {
      topbar.classList.remove("scrolled");
    }
  });

  // --- 任务面板展开/收起 ---
  tasksToggle.addEventListener("click", function () {
    tasksPanel.classList.add("expanded");
  });
  tasksClose.addEventListener("click", function () {
    tasksPanel.classList.remove("expanded");
  });

  // --- SSE 断线重连 ---
  var reconnectDelay = 1000;
  var maxReconnectDelay = 30000;
  var es = null;
  var historyLoaded = false;

  function setConnStatus(status) {
    if (!connStatusEl) return;
    connStatusEl.className = "conn-dot " + status;
    connStatusEl.title = status === "connected" ? "已连接" : status === "reconnecting" ? "重连中..." : "断开";
  }

  function connect() {
    if (es) { try { es.close(); } catch (e) {} }
    es = new EventSource("/events");

    es.onopen = function () {
      reconnectDelay = 1000;
      setConnStatus("connected");
      if (!historyLoaded) {
        historyLoaded = true;
        fetchState();
        loadChannels();
        loadChannelHistory(currentChannelId, true);
        fetch("/ui-ready", { method: "POST" });
      }
    };

    es.addEventListener("wenlu", function (e) {
      try { handle(JSON.parse(e.data)); } catch (err) { console.error(err); }
    });

    es.onerror = function () {
      setConnStatus("reconnecting");
      es.close();
      setTimeout(function () {
        reconnectDelay = Math.min(reconnectDelay * 2, maxReconnectDelay);
        connect();
      }, reconnectDelay);
    };
  }

  var seenEventIds = {};
  function handle(ev) {
    // eventId 去重（幂等）。
    if (ev.eventId) {
      if (seenEventIds[ev.eventId]) return;
      seenEventIds[ev.eventId] = 1;
    }
    // 归一化事件按 channelId 路由：仅当前频道渲染进 chat，否则只刷新左栏红点。
    switch (ev.type || ev.kind) {
      case "chat-reply":
        hideThinking();
        if (ev.role === "user") { loadChannels(); return; }
        if (ev.channelId === currentChannelId) {
          addMsg("wenlu", ev.text, null, ev.time, false);
          markChannelReadSilent(currentChannelId);
        }
        loadChannels();
        return;
      case "notification":
        hideThinking();
        if (ev.channelId === currentChannelId) {
          addMsg("wenlu", ev.text, ev.source || null, ev.time, false);
          markChannelReadSilent(currentChannelId);
        }
        loadChannels();
        return;
      case "decision-opened":
        hideThinking();
        if (ev.channelId === currentChannelId) {
          addAsk(ev.question, ev.options || [], ev.multi === true, ev.decisionId);
        }
        loadChannels();
        return;
    }
    switch (ev.kind) {
      case "state-changed":
        fetchState();
        break;
      case "delivery-report":
      case "blocking-question":
      case "awaiting-understanding":
      case "ready-confirm":
      case "backup-size-warning":
      case "error":
        fetchState();
        break;
      case "thinking":
        showThinking();
        break;
      case "say":
        // 兼容期旧事件：归一事件已处理过同内容则跳过（靠 eventId 去重；旧 say 无 channelId 不重复渲染）。
        break;
      case "ask":
        // 兼容期旧事件：由 decision-opened 处理。
        break;
      case "growth":
        cyclesEl.textContent = ev.cycles || "0";
        if (ev.understanding) understandingEl.textContent = ev.understanding.slice(0, 40) + "...";
        break;
      case "tasks":
        renderTasks(ev.tasks || []);
        break;
      case "idle":
        hideThinking();
        break;
    }
  }

  function fetchState() {
    fetch("/state").then(function (r) { return r.json(); }).then(function (d) {
      if (!d || !d.ok) return;
      renderState(d.summary || "", d.nextActions || []);
    }).catch(function () {});
  }

  function renderState(summary, nextActions) {
    if (stateSummaryEl) stateSummaryEl.textContent = summary || "";
    if (!nextActionsEl) return;
    if (!nextActions.length) {
      nextActionsEl.innerHTML = '<div class="tasks-empty">暂无下一步动作</div>';
      return;
    }
    nextActionsEl.innerHTML = nextActions.map(function (action, idx) {
      return '<button class="task-btn resume" data-next-action="' + idx + '">' + esc(action.label) + '</button>';
    }).join("");

    Array.prototype.forEach.call(nextActionsEl.querySelectorAll("[data-next-action]"), function (btn) {
      btn.addEventListener("click", function () {
        var action = nextActions[Number(btn.getAttribute("data-next-action"))];
        fetch(action.endpoint, {
          method: action.method,
          headers: { "Content-Type": "application/json" },
          body: action.method === "POST" ? JSON.stringify(action.payload || {}) : undefined,
        }).finally(fetchState);
      });
    });
  }

  // --- 任务渲染 ---
  function renderTasks(tasks) {
    var active = tasks.filter(function (t) { return t.status === "running" || t.status === "blocked"; });
    taskCountEl.textContent = active.length;
    tasksBadgeEl.textContent = active.length;
    tasksBadgeEl.className = "tasks-badge" + (active.length === 0 ? " empty" : "");

    if (!tasks.length) {
      tasksListEl.innerHTML = '<div class="tasks-empty">暂无任务</div>';
      return;
    }
    var order = { running: 0, blocked: 1, done: 2, failed: 3 };
    var sorted = tasks.slice().sort(function (a, b) { return (order[a.status] - order[b.status]); });
    tasksListEl.innerHTML = sorted.slice(0, 12).map(function (t) {
      var label = t.status === "running" ? "进行中" : t.status === "done" ? "完成" : t.status === "blocked" ? "卡住" : "失败";
      var fillCls = t.status === "done" ? "progress-fill done" : t.status === "running" ? "progress-fill running" : "progress-fill";
      var note = t.blockedReason || t.result || t.lastLog || "";
      var actions = '';
      if (t.status === "running") {
        actions = '<div class="task-actions">' +
          '<button class="task-btn pause" onclick="taskAction(\'' + t.id + '\',\'pause\')">暂停</button>' +
          '<button class="task-btn cancel" onclick="taskAction(\'' + t.id + '\',\'cancel\')">取消</button>' +
          '</div>';
      } else if (t.status === "blocked") {
        actions = '<div class="task-actions">' +
          '<button class="task-btn resume" onclick="taskAction(\'' + t.id + '\',\'resume\')">恢复</button>' +
          '<button class="task-btn cancel" onclick="taskAction(\'' + t.id + '\',\'cancel\')">取消</button>' +
          '</div>';
      }
      return '<div class="task-card">' +
        '<div class="goal">' + esc(t.goal) + '</div>' +
        '<div class="meta"><span class="status ' + t.status + '">' + label + '</span><span>' + (t.progress || 0) + '%</span></div>' +
        '<div class="progress-track"><div class="' + fillCls + '" style="width:' + (t.progress || 0) + '%"></div></div>' +
        (note ? '<div class="lastlog">' + esc(note.slice(0, 120)) + '</div>' : '') +
        actions +
        '</div>';
    }).join("");
  }

  window.taskAction = function (taskId, action) {
    fetch("/task/" + taskId + "/" + action, { method: "POST" })
      .then(function (r) { return r.json(); })
      .then(function (d) { if (!d.ok) console.warn("任务操作失败:", d.error); });
  };

  function esc(s) { var d = document.createElement("div"); d.textContent = s || ""; return d.innerHTML; }

  // --- 时间戳 ---
  function formatTime(isoStr) {
    if (!isoStr) return "";
    try {
      var d = new Date(isoStr);
      var now = new Date();
      var h = d.getHours().toString().padStart(2, "0");
      var m = d.getMinutes().toString().padStart(2, "0");
      if (d.toDateString() === now.toDateString()) return h + ":" + m;
      return (d.getMonth() + 1) + "/" + d.getDate() + " " + h + ":" + m;
    } catch (e) { return ""; }
  }

  // --- Markdown 渲染 ---
  function renderMd(text) {
    if (!text) return "";
    var html = esc(text);
    html = html.replace(/```([\s\S]*?)```/g, function (_, code) {
      return '<pre class="md-code">' + code.trim() + '</pre>';
    });
    html = html.replace(/`([^`]+)`/g, '<code class="md-inline">$1</code>');
    html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    return html;
  }

  // --- 打字机效果 ---
  function typewriter(el, html, callback) {
    var temp = document.createElement("div");
    temp.innerHTML = html;
    var text = temp.textContent || "";
    el.textContent = "";
    var i = 0;
    var speed = Math.max(12, Math.min(35, 800 / text.length));
    function tick() {
      if (i < text.length) {
        el.textContent += text[i];
        i++;
        chat.scrollTop = chat.scrollHeight;
        setTimeout(tick, speed);
      } else {
        el.innerHTML = html;
        if (callback) callback();
      }
    }
    tick();
  }

  // --- 消息追踪：连续同角色气泡圆角 + 时间分隔 ---
  var lastMsgRole = "";
  var lastMsgEl = null;
  var lastMsgTime = 0;
  var currentContextTag = "";
  var CONTEXT_GAP_MS = 10 * 60 * 1000; // 10 分钟

  function formatTimeFull(isoStr) {
    if (!isoStr) return "";
    try {
      var d = new Date(isoStr);
      var now = new Date();
      var h = d.getHours().toString().padStart(2, "0");
      var m = d.getMinutes().toString().padStart(2, "0");
      if (d.toDateString() === now.toDateString()) return "今天 " + h + ":" + m;
      var diff = now.getTime() - d.getTime();
      if (diff < 86400000 * 2) return "昨天 " + h + ":" + m;
      return (d.getMonth() + 1) + "月" + d.getDate() + "日 " + h + ":" + m;
    } catch (e) { return ""; }
  }

  function maybeInsertSeparator(time, contextTag) {
    var tMs = new Date(time).getTime();
    if (lastMsgTime && (tMs - lastMsgTime > CONTEXT_GAP_MS)) {
      var sep = document.createElement("div");
      sep.className = "time-separator";
      sep.innerHTML = '<span class="sep-line"></span><span class="sep-label">' +
        formatTimeFull(time) + '</span><span class="sep-line"></span>';
      chat.appendChild(sep);
    }
    if (contextTag && contextTag !== currentContextTag) {
      var anchor = document.createElement("div");
      anchor.className = "context-anchor";
      anchor.textContent = contextTag;
      chat.appendChild(anchor);
      currentContextTag = contextTag;
    }
  }

  function inferContextTag(text) {
    if (!text) return null;
    var m = text.match(/^【任务线[··]?[^\s]*】「(.+?)」/);
    if (m) return m[1];
    if (text.startsWith("⚠️ 任务线")) {
      var m2 = text.match(/「(.+?)」/);
      return m2 ? m2[1] : "任务异常";
    }
    return null;
  }

  function isTasklineMsg(text) {
    if (!text) return false;
    return /^【任务线[··]/.test(text) || /^⚠️ 任务线/.test(text);
  }

  function addMsg(role, text, growth, time, isHistory) {
    var ts = time || new Date().toISOString();
    var contextTag = (role !== "user") ? inferContextTag(text) : null;

    // 插入时间分隔线和上下文锚点
    maybeInsertSeparator(ts, contextTag);

    // 任务线消息 → 差异化渲染为折叠卡片
    if (role !== "user" && isTasklineMsg(text)) {
      var taskEl = document.createElement("div");
      taskEl.className = "msg taskline-msg";
      var goalMatch = text.match(/「(.+?)」/);
      var goalText = goalMatch ? goalMatch[1] : "任务";
      var statusMatch = text.match(/」(.+?)：/);
      var statusText = statusMatch ? statusMatch[1] : "";
      var bodyText = text.replace(/^【任务线[··]?[^\s]*】「.+?」[^：]*：?/, "").trim();

      taskEl.innerHTML = '<div class="taskline-header">' +
        '<span class="taskline-dot"></span>' +
        '<span class="taskline-goal">' + esc(goalText) + '</span>' +
        (statusText ? '<span class="taskline-status">' + esc(statusText) + '</span>' : '') +
        '</div>' +
        '<div class="taskline-body collapsed">' + renderMd(bodyText.slice(0, 200)) + '</div>' +
        (bodyText.length > 200 ? '<button class="taskline-expand">展开</button>' : '') +
        '<div class="msg-time">' + formatTime(ts) + '</div>';

      if (bodyText.length > 200) {
        taskEl.querySelector(".taskline-expand").addEventListener("click", function () {
          var bd = taskEl.querySelector(".taskline-body");
          var btn = taskEl.querySelector(".taskline-expand");
          if (bd.classList.contains("collapsed")) {
            bd.innerHTML = renderMd(bodyText);
            bd.classList.remove("collapsed");
            btn.textContent = "收起";
          } else {
            bd.innerHTML = renderMd(bodyText.slice(0, 200));
            bd.classList.add("collapsed");
            btn.textContent = "展开";
          }
        });
      }

      chat.appendChild(taskEl);
      chat.scrollTop = chat.scrollHeight;
      lastMsgRole = role;
      lastMsgEl = taskEl;
      lastMsgTime = new Date(ts).getTime();
      return;
    }

    var el = document.createElement("div");
    var isConsecutive = (role === lastMsgRole) && !contextTag;
    el.className = "msg " + (role === "user" ? "user" : "wenlu") + (isConsecutive ? " consecutive" : "");

    if (isConsecutive && lastMsgEl) {
      lastMsgEl.classList.add("consecutive");
    }

    var body = document.createElement("div");
    body.className = "msg-body";

    if (!isHistory && role !== "user" && text && text.length > 20) {
      el.appendChild(body);
      chat.appendChild(el);
      chat.scrollTop = chat.scrollHeight;
      typewriter(body, renderMd(text), function () {
        appendMeta(el, growth, time, role);
      });
    } else {
      body.innerHTML = renderMd(text);
      el.appendChild(body);
      appendMeta(el, growth, time, role);
      chat.appendChild(el);
      chat.scrollTop = chat.scrollHeight;
    }

    lastMsgRole = role;
    lastMsgEl = el;
    lastMsgTime = new Date(ts).getTime();
  }

  function appendMeta(el, growth, time, role) {
    if (growth) {
      var note = document.createElement("div");
      note.className = "growth-note";
      note.textContent = growth;
      el.appendChild(note);
    }

    var ts = time || new Date().toISOString();
    var tMs = new Date(ts).getTime();
    var showTime = (role !== lastMsgRole) || (tMs - lastMsgTime > 60000);
    if (showTime || !lastMsgTime) {
      var timeEl = document.createElement("div");
      timeEl.className = "msg-time";
      timeEl.textContent = formatTime(ts);
      el.appendChild(timeEl);
    }
  }

  // --- 校准提问 ---
  function addAsk(question, options, multi, decisionId) {
    var el = document.createElement("div");
    el.className = "msg wenlu ask";
    el.style.animationDelay = "0.05s";

    var q = document.createElement("div");
    q.className = "ask-q";
    q.textContent = question || "";
    el.appendChild(q);

    var opts = document.createElement("div");
    opts.className = "ask-opts";
    var picked = [];

    options.forEach(function (opt) {
      var b = document.createElement("button");
      b.className = "ask-opt";
      b.textContent = opt;
      b.addEventListener("click", function () {
        if (multi) {
          var i = picked.indexOf(opt);
          if (i >= 0) { picked.splice(i, 1); b.classList.remove("picked"); }
          else { picked.push(opt); b.classList.add("picked"); }
        } else {
          submitAnswer(question, [opt], el, decisionId);
        }
      });
      opts.appendChild(b);
    });
    el.appendChild(opts);

    if (multi) {
      var confirm = document.createElement("button");
      confirm.className = "ask-confirm";
      confirm.textContent = "确认";
      confirm.addEventListener("click", function () {
        if (picked.length === 0) return;
        submitAnswer(question, picked.slice(), el, decisionId);
      });
      el.appendChild(confirm);
    }

    chat.appendChild(el);
    chat.scrollTop = chat.scrollHeight;
  }

  function submitAnswer(question, choices, el, decisionId) {
    var btns = el.querySelectorAll(".ask-opt, .ask-confirm");
    btns.forEach(function (b) { b.disabled = true; });
    el.classList.add("answered");
    var ans = choices.join("、");
    addMsg("user", ans, null, new Date().toISOString(), false);
    // 裁决走专用端点（绝不复用 /say）。
    if (decisionId) {
      fetch("/decisions/" + decisionId + "/resolve", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ choice: choices })
      }).then(function () { loadChannels(); });
    } else {
      // 兼容期：无 decisionId 的旧提问退回 /say。
      var payload = "（针对你的提问「" + question + "」我的选择是：" + ans + "）";
      fetch("/say", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: payload, channelId: currentChannelId }) });
    }
  }

  // --- 思考指示 ---
  function showThinking() {
    if (thinkingEl) return;
    thinkingEl = document.createElement("div");
    thinkingEl.className = "thinking";
    thinkingEl.innerHTML = '思考中 <div class="thinking-dots"><span></span><span></span><span></span></div>';
    chat.appendChild(thinkingEl);
    chat.scrollTop = chat.scrollHeight;
  }

  function hideThinking() {
    if (thinkingEl) { thinkingEl.remove(); thinkingEl = null; }
  }

  // --- 发送 ---
  function send() {
    var text = input.value.trim();
    if (!text) return;

    sendBtn.classList.add("sending");
    setTimeout(function () { sendBtn.classList.remove("sending"); }, 300);

    addMsg("user", text, null, new Date().toISOString(), false);
    input.value = "";
    autoResize();
    updateSendBtn();
    fetch("/say", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: text, channelId: currentChannelId }) });
  }

  sendBtn.addEventListener("click", send);
  input.addEventListener("keydown", function (e) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });

  // --- 河床摘要浮层 ---
  var riverbedPanel = document.getElementById("riverbed-panel");
  var riverbedToggle = document.getElementById("riverbed-toggle");
  var riverbedClose = document.getElementById("riverbed-close");
  var riverbedBody = document.getElementById("riverbed-body");
  var riverbedUpdated = document.getElementById("riverbed-updated");

  if (riverbedToggle) {
    riverbedToggle.addEventListener("click", function () {
      riverbedPanel.classList.toggle("expanded");
      if (riverbedPanel.classList.contains("expanded")) fetchRiverbed();
    });
  }
  if (riverbedClose) {
    riverbedClose.addEventListener("click", function () {
      riverbedPanel.classList.remove("expanded");
    });
  }

  function fetchRiverbed() {
    fetch("/riverbed-summary").then(function (r) { return r.json(); }).then(function (d) {
      if (!d.ok) { riverbedBody.textContent = "（暂无河床数据）"; return; }
      riverbedBody.textContent = d.summary || "（河床尚在形成）";
      riverbedUpdated.textContent = d.updatedAt ? "更新于 " + formatTimeFull(d.updatedAt) : "";
    }).catch(function () { riverbedBody.textContent = "（获取失败）"; });
  }

  // ═══════════ 频道侧栏（消费 /channels，单 SSE 不重连）═══════════
  var topicsSidebar = document.getElementById("topics-sidebar");
  var topicsList = document.getElementById("topics-list");
  var topicsNewBtn = document.getElementById("topics-new-btn");
  var topicsToggleBtn = document.getElementById("topics-toggle-btn");

  function getCurrentAccountId() {
    try {
      var authUser = JSON.parse(localStorage.getItem("auth_user") || "null");
      return authUser && authUser.id ? String(authUser.id) : "guest";
    } catch (e) {
      return "guest";
    }
  }

  function getCurrentChannelStorageKey() {
    return "wenlu_current_channel::" + getCurrentAccountId();
  }

  // 当前查看频道：按账号分开存储（后端不持有 active）。
  var currentChannelId = (function () {
    try { return localStorage.getItem(getCurrentChannelStorageKey()) || "chat_default"; } catch (e) { return "chat_default"; }
  })();
  var channelKindMap = {}; // id -> kind

  var GROUP_ORDER = ["decisions", "notifications", "user-chat"];
  var GROUP_LABELS = { decisions: "待你裁决", notifications: "通知", "user-chat": "我的会话" };

  function setCurrentChannel(id) {
    currentChannelId = id;
    try { localStorage.setItem(getCurrentChannelStorageKey(), id); } catch (e) {}
  }

  function isSystemChannel(id) {
    return channelKindMap[id] === "decisions" || channelKindMap[id] === "notifications";
  }

  function applyInputAvailability() {
    // 系统频道（decisions/notifications）禁用输入框。
    var wrap = document.getElementById("input-wrap");
    if (!wrap) return;
    if (isSystemChannel(currentChannelId)) {
      input.disabled = true;
      input.placeholder = "系统频道（只读）";
      wrap.style.opacity = "0.5";
    } else {
      input.disabled = false;
      input.placeholder = "说点什么...";
      wrap.style.opacity = "1";
    }
  }

  function loadChannels() {
    fetch("/channels").then(function (r) { return r.json(); }).then(function (d) {
      if (!d.ok) return;
      channelKindMap = {};
      (d.channels || []).forEach(function (c) { channelKindMap[c.id] = c.kind; });
      // 当前频道若已不存在，回退默认。
      if (!channelKindMap[currentChannelId]) setCurrentChannel("chat_default");
      renderChannelList(d.groups || {});
      applyInputAvailability();
    }).catch(function () {});
  }

  function renderChannelList(groups) {
    topicsList.innerHTML = "";
    GROUP_ORDER.forEach(function (g) {
      var items = groups[g] || [];
      if (items.length === 0 && g === "user-chat") {
        // 用户会话组即使空也显示标题（让"+"有归属感）。
      } else if (items.length === 0) {
        return;
      }
      var groupEl = document.createElement("div");
      groupEl.className = "topic-group";
      var header = document.createElement("div");
      header.className = "topic-group-header";
      header.textContent = GROUP_LABELS[g] || g;
      groupEl.appendChild(header);
      items.forEach(function (c) {
        var item = document.createElement("div");
        item.className = "topic-item" + (c.id === currentChannelId ? " active" : "");
        var nameSpan = document.createElement("span");
        nameSpan.className = "topic-name";
        nameSpan.textContent = c.title;
        item.appendChild(nameSpan);
        if (c.unread > 0) {
          var badge = document.createElement("span");
          // decisions 强红点；其余弱红点。
          badge.className = "topic-badge" + (g === "decisions" ? " strong" : "");
          badge.textContent = c.unread > 99 ? "99+" : c.unread;
          item.appendChild(badge);
        }
        // 仅用户会话可删。
        if (g === "user-chat") {
          var delBtn = document.createElement("button");
          delBtn.className = "topic-del";
          delBtn.textContent = "×";
          delBtn.onclick = function (e) { e.stopPropagation(); archiveChannel(c.id); };
          item.appendChild(delBtn);
        }
        item.onclick = function () { switchChannel(c.id); };
        groupEl.appendChild(item);
      });
      topicsList.appendChild(groupEl);
    });
  }

  // 切频道：只换历史 + 推 read cursor，绝不重连 SSE、绝不改后端 active。
  function switchChannel(id) {
    if (id === currentChannelId) return;
    setCurrentChannel(id);
    loadChannelHistory(id, false);
    markChannelReadSilent(id);
    loadChannels();
    applyInputAvailability();
  }

  function loadChannelHistory(id, withMeta) {
    // 先取 pending 裁决集（用于把仍未结的裁决渲染成可点选项）。
    fetch("/decisions").then(function (r) { return r.json(); }).then(function (dd) {
      var pendingById = {};
      if (dd && dd.ok) (dd.decisions || []).forEach(function (x) { pendingById[x.messageId] = x; });
      return pendingById;
    }).catch(function () { return {}; }).then(function (pendingById) {
      fetch("/history?channelId=" + encodeURIComponent(id)).then(function (r) { return r.json(); }).then(function (d) {
        chat.innerHTML = "";
        lastMsgRole = ""; lastMsgEl = null; lastMsgTime = 0; currentContextTag = "";
        (d.history || []).forEach(function (m) {
          if (m.kind === "decision" && pendingById[m.id]) {
            // 仍未结的裁决 → 渲染为可点选项。
            var dec = pendingById[m.id];
            addAsk(dec.question, dec.options || [], dec.multi === true, dec.id);
          } else {
            addMsg(m.role || "wenlu", m.text, m.source || null, m.time, true);
          }
        });
        if (withMeta) {
          if (d.cycles) cyclesEl.textContent = d.cycles;
          if (d.understanding) understandingEl.textContent = d.understanding.slice(0, 40) + "...";
          if (d.tasks) renderTasks(d.tasks);
        }
        markChannelReadSilent(id);
      }).catch(function () {});
    });
  }

  function markChannelReadSilent(id) {
    fetch("/channels/" + encodeURIComponent(id) + "/read", { method: "POST" }).catch(function () {});
  }

  function createChannel() {
    var name = prompt("新会话名称：");
    if (!name || !name.trim()) return;
    fetch("/channels/create", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: name.trim() })
    }).then(function (r) { return r.json(); }).then(function (d) {
      if (!d.ok) return;
      switchChannel(d.id);
    });
  }

  function archiveChannel(id) {
    if (!confirm("确定删除此会话？（弟弟对你的理解不会丢失）")) return;
    fetch("/channels/" + encodeURIComponent(id) + "/archive", { method: "POST" })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d.ok) return;
        if (id === currentChannelId) {
          setCurrentChannel("chat_default");
          loadChannelHistory("chat_default", false);
        }
        loadChannels();
      });
  }

  if (topicsNewBtn) topicsNewBtn.onclick = createChannel;
  if (topicsToggleBtn) topicsToggleBtn.onclick = function () { topicsSidebar.classList.remove("collapsed"); };

  updateSendBtn();
  connect();
})();
